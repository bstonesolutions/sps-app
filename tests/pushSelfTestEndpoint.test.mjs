import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The endpoint captures server configuration at import time. These are inert test-only values;
// the intentionally invalid private key makes the APNs failure path deterministic and prevents
// this test from opening a network connection.
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.APNS_KEY_ID = "TESTKEY123";
process.env.APNS_TEAM_ID = "TESTTEAM12";
process.env.APNS_PRIVATE_KEY = "not-a-real-p8-key";

const { default: pushRegisterHandler } = await import("../api/push/register.js");
const { default: sendPushHandler } = await import("../api/send-push.js");
const { filterCurrentTeamPushTokens, pushOwner, pushClient, pushStaff } = await import("../api/_push.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function post(body, token = "signed-in-session") {
  return {
    method: "POST",
    query: {},
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  };
}

function installVerifiedFetch({ rows = [], tokenLookupStatus = 200, email = "owner@example.test" } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "auth-user-1", email });
    }
    if (target.includes("/rest/v1/sps_push_tokens?")) {
      return tokenLookupStatus === 200
        ? response(rows)
        : response({ message: "provider detail must stay private" }, { ok: false, status: tokenLookupStatus });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  return calls;
}

test("public GET health check remains available without an upstream lookup", async () => {
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("GET must remain local"); };
  const res = makeRes();
  await pushRegisterHandler({ method: "GET", headers: {}, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, configured: { apns: true } });
  assert.equal(upstreamCalls, 0);
});

test("status and self-test reject requests without a verified Supabase session", async (t) => {
  for (const action of ["status", "test"]) {
    await t.test(action, async () => {
      let tokenLookups = 0;
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.endsWith("/auth/v1/user")) return response({ error: "invalid token" }, { ok: false, status: 401 });
        if (target.includes("/rest/v1/sps_push_tokens?")) tokenLookups += 1;
        throw new Error(`Unexpected fetch: ${target}`);
      };
      const res = makeRes();
      await pushRegisterHandler(post({ action }, "invalid-session"), res);

      assert.equal(res.statusCode, 401);
      assert.equal(tokenLookups, 0);
    });
  }
});

test("registration status is authenticated, caller-scoped, and never returns token material", async () => {
  const deviceTokenA = "a".repeat(64);
  const deviceTokenB = "b".repeat(64);
  const calls = installVerifiedFetch({
    rows: [
      { token: deviceTokenA, role: "owner", user_key: "owner-1" },
      { token: deviceTokenB, role: "owner", user_key: "owner-1" },
    ],
  });
  const res = makeRes();
  await pushRegisterHandler(post({ action: "status", user_email: "attacker@example.test" }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { configured: true, bound: true, deviceCount: 2 });
  assert.deepEqual(Object.keys(res.body).sort(), ["bound", "configured", "deviceCount"]);
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(`${deviceTokenA}|${deviceTokenB}|owner@example|attacker@example`, "i"));

  const lookup = calls.find((call) => call.target.includes("/rest/v1/sps_push_tokens?"));
  assert.ok(lookup, "expected an enabled-token lookup");
  assert.match(lookup.target, /user_email=eq\.owner%40example\.test/);
  assert.match(lookup.target, /enabled=eq\.true/);
  assert.doesNotMatch(lookup.target, /attacker/i);
});

test("current-device status is scoped to the verified email and exact stable install", async () => {
  const installId = "install_1234567890abcdef";
  const calls = installVerifiedFetch({ rows: [{ token: "a".repeat(64), role: "owner", user_key: "owner-1" }] });
  const res = makeRes();
  await pushRegisterHandler(post({ action: "status", installId }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bound, true);
  const lookup = calls.find((call) => call.target.includes("/rest/v1/sps_push_tokens?"));
  assert.match(lookup.target, /user_email=eq\.owner%40example\.test/);
  assert.match(lookup.target, /platform=eq\.ios%3Ainstall_1234567890abcdef/);
});

test("status fails closed when the token store is unavailable", async () => {
  installVerifiedFetch({ tokenLookupStatus: 503 });
  const res = makeRes();
  await pushRegisterHandler(post({ action: "status" }), res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: "Notification registration status is temporarily unavailable." });
  assert.doesNotMatch(JSON.stringify(res.body), /provider detail/i);
});

test("status does not misreport a malformed token-store response as zero devices", async () => {
  installVerifiedFetch({ rows: { token: "should-have-been-an-array" } });
  const res = makeRes();
  await pushRegisterHandler(post({ action: "status" }), res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: "Notification registration status is temporarily unavailable." });
});

test("inbound-text push honors its dedicated owner switch with legacy client-message fallback", async (t) => {
  const installPreferenceFetch = (events) => {
    const calls = [];
    globalThis.fetch = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_email")) {
        return response([{ value: JSON.stringify({
          notify: { events },
          testMode: { on: false, mode: "redirect", phone: "", liveClientIds: [] },
        }) }]);
      }
      if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
        return response([{ value: JSON.stringify([{ id: "owner-1", email: "owner@example.test", role: "owner", active: true }]) }]);
      }
      if (target.includes("/rest/v1/sps_push_tokens?")) return response([]);
      throw new Error(`Unexpected fetch: ${target}`);
    };
    return calls;
  };

  await t.test("dedicated opt-out", async () => {
    const calls = installPreferenceFetch({ inbound_text: { push: false }, client_message: { push: true } });
    const result = await pushOwner("inbound_text", "Text", "Preview", "comms");
    assert.equal(result.ok, true);
    assert.match(result.skipped || "", /turned off/i);
    assert.equal(calls.filter((target) => target.includes("sps_push_tokens")).length, 0);
  });

  await t.test("legacy fallback opt-out", async () => {
    const calls = installPreferenceFetch({ client_message: { push: false } });
    const result = await pushOwner("inbound_text", "Text", "Preview", "comms");
    assert.equal(result.ok, true);
    assert.match(result.skipped || "", /turned off/i);
    assert.equal(calls.filter((target) => target.includes("sps_push_tokens")).length, 0);
  });

  await t.test("dedicated setting wins once present", async () => {
    const calls = installPreferenceFetch({ inbound_text: { push: true }, client_message: { push: false } });
    const result = await pushOwner("inbound_text", "Text", "Preview", "comms");
    assert.equal(result.ok, true);
    assert.equal(result.reason, "no registered devices");
    assert.equal(calls.filter((target) => target.includes("sps_push_tokens")).length, 1);
  });
});

test("malformed Test Mode settings fail closed before any audience token lookup", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_email")) {
      return response([{ value: JSON.stringify({ notify: { events: {} } }) }]);
    }
    if (target.includes("/rest/v1/sps_push_tokens?")) return response([]);
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const owner = await pushOwner("inbound_text", "Text", "Preview", "comms/inbox");
  const client = await pushClient("client-1", "Message", "Preview", "messages");
  const staff = await pushStaff("staff-1", "Stop assigned", "Preview", "schedule");

  assert.deepEqual(owner, {
    ok: false,
    retryable: true,
    error: "notification settings are temporarily unavailable",
  });
  assert.equal(client.ok, true);
  assert.equal(client.held, true);
  assert.match(client.skipped, /fail closed/i);
  assert.equal(staff.ok, true);
  assert.equal(staff.held, true);
  assert.match(staff.skipped, /fail closed/i);
  assert.equal(calls.filter((target) => target.includes("sps_push_tokens")).length, 0);
});

test("owner push tokens are authorized from the current active roster, not their stored role", () => {
  const row = { token: "a".repeat(64), role: "owner", user_key: "owner-1", user_email: "owner@example.test" };
  const currentOwner = [{ id: "owner-1", email: "owner@example.test", role: "owner", active: true }];
  assert.deepEqual(filterCurrentTeamPushTokens([row], currentOwner, { audience: "owner" }), [row]);

  const deniedTeams = [
    [{ id: "owner-1", email: "owner@example.test", role: "full", active: true }],
    [{ id: "owner-1", email: "owner@example.test", role: "owner", active: false }],
    [{ id: "owner-2", email: "owner@example.test", role: "owner", active: true }],
    [],
  ];
  deniedTeams.forEach((team) => {
    assert.deepEqual(filterCurrentTeamPushTokens([row], team, { audience: "owner" }), []);
  });
  assert.deepEqual(filterCurrentTeamPushTokens([row], [...currentOwner, ...currentOwner], { audience: "owner" }), []);
});

test("staff push tokens require the same active member and exact current capability", () => {
  const row = { token: "b".repeat(64), role: "staff", user_key: "tech-1", user_email: "tech@example.test" };
  const allowed = [{
    id: "tech-1",
    email: "tech@example.test",
    role: "field",
    active: true,
    tabAccess: { comms: "edit", schedule: "edit" },
    fine: { commsTextInbox: true, commsMainLine: false },
  }];
  assert.deepEqual(filterCurrentTeamPushTokens([row], allowed, {
    audience: "staff",
    staffKey: "tech-1",
    requiredCapability: "commsTextInbox",
  }), [row]);

  assert.deepEqual(filterCurrentTeamPushTokens([row], allowed, {
    audience: "staff",
    staffKey: "tech-1",
    requiredCapability: "commsMainLine",
  }), []);
  assert.deepEqual(filterCurrentTeamPushTokens([row], [{ ...allowed[0], role: "owner" }], {
    audience: "staff",
    staffKey: "tech-1",
    requiredCapability: "commsTextInbox",
  }), []);
  assert.deepEqual(filterCurrentTeamPushTokens([row], [{ ...allowed[0], disabled: true }], {
    audience: "staff",
    staffKey: "tech-1",
    requiredCapability: "commsTextInbox",
  }), []);
  assert.deepEqual(filterCurrentTeamPushTokens([row], allowed, {
    audience: "staff",
    staffKey: "different-tech",
    requiredCapability: "commsTextInbox",
  }), []);
  assert.deepEqual(filterCurrentTeamPushTokens([row], allowed, {
    audience: "staff",
    staffKey: "tech-1",
  }), [], "a new staff push call site must declare its exact capability");
});

test("client push keeps its portal-only audience path and does not read the team roster", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("key=eq.sps_email")) {
      return response([{ value: JSON.stringify({ notify: { events: {} }, testMode: { on: false, liveClientIds: [] } }) }]);
    }
    if (target.includes("/rest/v1/sps_push_tokens?")) return response([]);
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const result = await pushClient("client-1", "Message", "Preview", "messages");
  assert.equal(result.ok, true);
  assert.equal(result.reason, "no registered devices");
  assert.equal(calls.some((target) => target.includes("key=eq.sps_team")), false);
});

test("team lookup failures hold owner and staff business alerts fail closed", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("key=eq.sps_email")) {
      return response([{ value: JSON.stringify({ notify: { events: {} }, testMode: { on: false, liveClientIds: [] } }) }]);
    }
    if (target.includes("key=eq.sps_team")) return response({ error: "offline" }, { ok: false, status: 503 });
    if (target.includes("/rest/v1/sps_push_tokens?")) return response([]);
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const owner = await pushOwner("inbound_text", "Text", "Preview", "comms/inbox");
  const staff = await pushStaff("tech-1", "Text", "Preview", "comms/inbox", { requiredCapability: "commsTextInbox" });
  assert.equal(owner.ok, false);
  assert.match(owner.error, /team roster lookup failed/i);
  assert.equal(staff.ok, false);
  assert.match(staff.error, /team roster lookup failed/i);
  assert.equal(calls.filter((target) => target.includes("key=eq.sps_team")).length, 2);
});

test("generic send-push rejects staff without the event's action permission", async (t) => {
  const run = async (member, event, body = {}) => {
    let nonAuthLookup = false;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.endsWith("/auth/v1/user")) return response({ id: "auth-tech", email: member.email });
      if (target.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([member]) }]);
      nonAuthLookup = true;
      throw new Error(`Unexpected fetch after authorization: ${target}`);
    };
    const res = makeRes();
    await sendPushHandler(post({ event, ...body }), res);
    return { res, nonAuthLookup };
  };

  await t.test("field staff cannot send arbitrary assignment pushes", async () => {
    const { res, nonAuthLookup } = await run({
      id: "field-1", email: "field@example.test", role: "field", active: true,
      tabAccess: { schedule: "edit" }, fine: { scheduleAddRemove: false },
    }, "stop_assigned", { staffId: "someone-else" });
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /permissions/i);
    assert.equal(nonAuthLookup, false);
  });

  await t.test("staff cannot forge client-only owner alerts", async () => {
    const { res, nonAuthLookup } = await run({
      id: "field-1", email: "field@example.test", role: "field", active: true,
      tabAccess: { schedule: "edit" },
    }, "service_request", { title: "Forged title" });
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /permissions/i);
    assert.equal(nonAuthLookup, false);
  });
});

test("authorized schedule editors keep assignment pushes, with recipient capability revalidation", async () => {
  const team = [
    {
      id: "lead-1", email: "lead@example.test", role: "lead", active: true,
      tabAccess: { schedule: "edit" }, fine: { scheduleAddRemove: true },
    },
    {
      id: "tech-1", email: "tech@example.test", role: "field", active: true,
      tabAccess: { schedule: "edit" },
    },
  ];
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith("/auth/v1/user")) return response({ id: "auth-lead", email: "lead@example.test" });
    if (target.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (target.includes("key=eq.sps_email")) {
      return response([{ value: JSON.stringify({ notify: { events: {} }, testMode: { on: false, liveClientIds: [] } }) }]);
    }
    if (target.includes("/rest/v1/sps_push_tokens?")) return response([]);
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const res = makeRes();
  await sendPushHandler(post({ event: "stop_assigned", staffId: "tech-1", body: "A stop was assigned" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, sent: 0, reason: "no registered devices" });
  const lookup = calls.find((call) => call.target.includes("/rest/v1/sps_push_tokens?"));
  assert.ok(lookup);
  assert.match(lookup.target, /role=eq\.staff/);
  assert.match(lookup.target, /user_key=eq\.tech-1/);
  assert.match(lookup.target, /select=token,role,user_key,user_email/);
});

test("inbound line and assignment callers forward exact recipient capabilities", async () => {
  const [intake, endpoint] = await Promise.all([
    readFile(new URL("../api/sms-intake.js", import.meta.url), "utf8"),
    readFile(new URL("../api/send-push.js", import.meta.url), "utf8"),
  ]);
  assert.match(intake, /requiredCapability: staffCapability/);
  assert.match(intake, /quoLine === "main" \? "commsMainLine" : quoLine === "automation" \? "commsTextInbox"/);
  assert.match(endpoint, /recipientCapability: "completeStops"/);
  assert.match(endpoint, /requiredCapability: ev\.recipientCapability/);
});

test("self-test ignores body identity claims and safely contains APNs key errors", async () => {
  const calls = installVerifiedFetch({ rows: [{ token: "c".repeat(64), role: "owner", user_key: "owner-1" }] });
  const res = makeRes();
  await pushRegisterHandler(post({
    action: "test",
    user_email: "attacker@example.test",
    userKey: "attacker-1",
    role: "owner",
    token: "d".repeat(64),
  }), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.sent, 0);
  assert.match(res.body.error, /could not be delivered/i);
  assert.doesNotMatch(JSON.stringify(res.body), /key problem|not-a-real|attacker@example/i);

  const lookup = calls.find((call) => call.target.includes("/rest/v1/sps_push_tokens?"));
  assert.match(lookup.target, /user_email=eq\.owner%40example\.test/);
  assert.doesNotMatch(lookup.target, /attacker/i);
});

test("self-test reports an unbound caller without attempting APNs", async () => {
  const calls = installVerifiedFetch({ rows: [] });
  const res = makeRes();
  await pushRegisterHandler(post({ action: "test" }), res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    ok: false,
    sent: 0,
    error: "No enabled notification device is registered for this account.",
  });
  assert.equal(calls.filter((call) => call.target.includes("/rest/v1/sps_push_tokens?")).length, 1);
});

test("unregister can delete only a token bound to the verified email", async () => {
  const calls = installVerifiedFetch({ rows: [{ token: "e".repeat(64) }] });
  const res = makeRes();
  await pushRegisterHandler(post({ token: "e".repeat(64), remove: true, user_email: "attacker@example.test" }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, removed: true });
  const removal = calls.find((call) => call.options.method === "DELETE");
  assert.ok(removal, "expected a token deletion");
  assert.match(removal.target, /token=eq\.e{64}/);
  assert.match(removal.target, /user_email=eq\.owner%40example\.test/);
  assert.doesNotMatch(removal.target, /attacker/i);
});

test("cold-launch unregister removes only this verified account and physical install", async () => {
  const installId = "install_1234567890abcdef";
  const calls = installVerifiedFetch({ rows: [{ token: "a".repeat(64) }, { token: "b".repeat(64) }] });
  const res = makeRes();
  await pushRegisterHandler(post({ action: "unregister", installId, user_email: "attacker@example.test" }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, removed: true, removedCount: 2 });
  const removal = calls.find((call) => call.options.method === "DELETE");
  assert.ok(removal);
  assert.match(removal.target, /user_email=eq\.owner%40example\.test/);
  assert.match(removal.target, /platform=eq\.ios%3Ainstall_1234567890abcdef/);
  assert.doesNotMatch(removal.target, /token=eq|attacker/i);
  assert.equal(removal.options.headers.Prefer, "return=representation");
});

test("cold-launch unregister requires an install id and propagates token-store failure", async (t) => {
  await t.test("missing install id", async () => {
    installVerifiedFetch();
    const res = makeRes();
    await pushRegisterHandler(post({ action: "unregister" }), res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { ok: false, removed: false, removedCount: 0, error: "A valid notification install identifier is required." });
  });

  await t.test("upstream delete failure", async () => {
    installVerifiedFetch({ tokenLookupStatus: 503 });
    const res = makeRes();
    await pushRegisterHandler(post({ action: "unregister", installId: "install_1234567890abcdef" }), res);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { ok: false, removed: false, removedCount: 0, error: "Couldn't unlink this notification device." });
  });
});

test("ordinary device registration still binds the token to the verified active team member", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith("/auth/v1/user")) return response({ id: "auth-user-1", email: "tech@example.test" });
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ id: "tech-1", email: "tech@example.test", role: "field", active: true }]) }]);
    }
    if (target.includes("/rest/v1/sps_push_tokens?on_conflict=token")) return response([]);
    if (target.includes("/rest/v1/sps_push_tokens?") && options.method === "DELETE") return response([]);
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const res = makeRes();
  await pushRegisterHandler(post({ action: "register", token: "f".repeat(64), installId: "install_1234567890abcdef", role: "owner", user_key: "attacker" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.role, "staff");
  const upsert = calls.find((call) => call.options.method === "POST" && call.target.includes("on_conflict=token"));
  assert.ok(upsert, "expected a token upsert");
  const [row] = JSON.parse(upsert.options.body);
  assert.equal(row.user_email, "tech@example.test");
  assert.equal(row.user_key, "tech-1");
  assert.equal(row.role, "staff");
  assert.equal(row.token, "f".repeat(64));
  assert.equal(row.platform, "ios:install_1234567890abcdef");
  const cleanup = calls.find((call) => call.options.method === "DELETE");
  assert.ok(cleanup, "expected stale tokens for this install to be pruned");
  assert.match(cleanup.target, /user_email=eq\.tech%40example\.test/);
  assert.match(cleanup.target, /platform=eq\.ios%3Ainstall_1234567890abcdef/);
  assert.match(cleanup.target, /token=neq\.f{64}/);
});

test("self-test deliberately bypasses Test Mode but retains shared invalid-token pruning", async () => {
  const source = await readFile(new URL("../api/_push.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function pushUserSelfTest");
  const end = source.indexOf("// ── Audience helpers", start);
  const selfTest = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(selfTest, /const filter = `user_email=eq\.\$\{encodeURIComponent\(email\)\}/);
  assert.match(selfTest, /platform=eq\.\$\{encodeURIComponent\(scopedPlatform\)\}/);
  assert.match(selfTest, /getTokens\(filter, \{ strict: true, timeoutMs: 3000 \}\)/);
  assert.match(selfTest, /return await sendToTokens\(rows/);
  assert.doesNotMatch(selfTest, /getEmailCfg|testMode/);
  assert.match(source, /reason === "Unregistered"/);
  assert.match(source, /reason === "DeviceTokenNotForTopic"/);
  assert.match(source, /reason === "BadDeviceToken" && prodHost/);
  assert.match(source, /await pruneToken\(row\.token/);
  assert.match(source, /if \(await pruneToken\(row\.token/);
  assert.match(source, /Prefer: "return=representation"/);
});
