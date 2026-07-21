import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: smsInboxHandler } = await import("../api/sms-inbox.js");

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

function request(method = "GET", { query = {}, body = {}, token = "staff-token" } = {}) {
  return {
    method,
    query,
    body,
    headers: { authorization: `Bearer ${token}` },
  };
}

const automationStaff = () => ({
  id: "staff-1",
  email: "tech@example.test",
  role: "field",
  tabAccess: { schedule: "edit", comms: "edit" },
});

const inboxStaff = ({ main = false, automation = true } = {}) => ({
  ...automationStaff(),
  fine: { ...(automation ? { commsTextInbox: true } : {}), ...(main ? { commsMainLine: true } : {}) },
});

const ownerStaff = () => ({
  id: "owner-1",
  email: "tech@example.test",
  role: "owner",
});

const rows = [
  { id: "sms-auto", channel: "sms", from_phone: "+15551110001", read: false, ai: { quoLine: "automation" } },
  { id: "sms-legacy", channel: "sms", from_phone: "+15551110002", read: false, ai: { summary: "legacy row" } },
  { id: "sms-main", channel: "sms", from_phone: "+15551110003", read: false, ai: { quoLine: "main" } },
  { id: "sms-unknown", channel: "sms", from_phone: "+15551110004", read: false, ai: { quoLine: "unexpected" } },
  { id: "sms-malformed", channel: "sms", from_phone: "+15551110005", read: false, ai: "not-json" },
  { id: "email-row", channel: "email", from_email: "private@example.test", read: false, ai: {} },
];

function idsFromUrl(target) {
  const parsed = new URL(target);
  const raw = parsed.searchParams.get("id") || "";
  const match = /^in\.\((.*)\)$/.exec(raw);
  return match ? match[1].split(",").map(decodeURIComponent) : [];
}

function installFetch({ team, listRows = rows } = {}) {
  const calls = { list: 0, lookups: 0, mutations: 0, mutationMethods: [], urls: [] };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.urls.push(target);
    if (target.endsWith("/auth/v1/user")) return response({ id: "auth-user-1", email: "tech@example.test" });
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify(team || [inboxStaff()]) }]);
    }
    if (target.includes("/rest/v1/sps_inbox?") && ["PATCH", "DELETE"].includes(options.method)) {
      calls.mutations += 1;
      calls.mutationMethods.push(options.method);
      const wanted = new Set(idsFromUrl(target));
      return response(listRows.filter((row) => wanted.has(row.id)).map(({ id, channel, ai }) => ({ id, channel, ai })));
    }
    if (target.includes("/rest/v1/sps_inbox?") && target.includes("select=id,channel,ai")) {
      if (target.includes("read=not.is.true")) {
        return response(listRows.filter((row) => row.read !== true).map(({ id, channel, ai }) => ({ id, channel, ai })));
      }
      calls.lookups += 1;
      const wanted = new Set(idsFromUrl(target));
      return response(listRows.filter((row) => wanted.has(row.id)).map(({ id, channel, ai }) => ({ id, channel, ai })));
    }
    if (target.includes("/rest/v1/sps_inbox?") && target.includes("select=*")) {
      calls.list += 1;
      // Deliberately return rows outside the PostgREST predicate. The endpoint must still apply its
      // fail-closed serializer filter before anything reaches a staff browser.
      return response(listRows);
    }
    if (target.includes("/rest/v1/sps_inbox?") && target.includes("select=id")) {
      return response(listRows.filter((row) => row.read !== true).map(({ id }) => ({ id })));
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  return calls;
}

test("the SMS inbox is denied unless the owner explicitly grants text-inbox access", async () => {
  const calls = installFetch({ team: [automationStaff()] });
  const res = makeRes();
  await smsInboxHandler(request("GET", { query: { limit: "100" } }), res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /team permissions/i);
  assert.equal(calls.list, 0);
});

test("ordinary inbox delegates see only automation and legacy SMS, never email or the owner line", async () => {
  const calls = installFetch({ team: [inboxStaff()] });
  const res = makeRes();
  await smsInboxHandler(request("GET", { query: { limit: "100" } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.access, { automation: true, main: false });
  assert.deepEqual(res.body.rows.map((row) => row.id), ["sms-auto", "sms-legacy"]);
  assert.equal(calls.list, 1);
  assert.ok(calls.urls.some((url) => url.includes("channel=eq.sms")), "database query must also be SMS-scoped");
});

test("the unread summary revalidates line metadata and never counts email, main, or malformed rows for an ordinary delegate", async () => {
  installFetch({ team: [inboxStaff()] });
  const res = makeRes();
  await smsInboxHandler(request("GET", { query: { summary: "unread" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.unread, 2);
  assert.deepEqual(res.body.access, { automation: true, main: false });
});

test("the owner and explicitly granted delegates can see both SPS text lines but still no email", async (t) => {
  for (const [label, member] of [
    ["owner", ownerStaff()],
    ["delegate", inboxStaff({ main: true })],
  ]) {
    await t.test(label, async () => {
      installFetch({ team: [member] });
      const res = makeRes();
      await smsInboxHandler(request("GET", { query: { limit: "100" } }), res);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.access, { automation: true, main: true });
      assert.deepEqual(res.body.rows.map((row) => row.id), ["sms-auto", "sms-legacy", "sms-main"]);
      assert.equal(res.body.rows.some((row) => row.channel === "email"), false);
    });
  }
});

test("the owner can grant the owner-number inbox without exposing the staff-number inbox", async () => {
  installFetch({ team: [inboxStaff({ main: true, automation: false })] });
  const res = makeRes();
  await smsInboxHandler(request("GET", { query: { limit: "100" } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.access, { automation: false, main: true });
  assert.deepEqual(res.body.rows.map((row) => row.id), ["sms-main"]);
});

test("forged non-destructive mutations of the owner line, email, or unknown-line rows fail before Supabase changes anything", async (t) => {
  for (const id of ["sms-main", "email-row", "sms-unknown", "sms-malformed"]) {
    await t.test(id, async () => {
      const calls = installFetch({ team: [inboxStaff()] });
      const res = makeRes();
      await smsInboxHandler(request("POST", { body: { action: "markRead", ids: [id] } }), res);

      assert.equal(res.statusCode, 403);
      assert.match(res.body.error, /unavailable with your current permissions/i);
      assert.equal(calls.lookups, 1);
      assert.equal(calls.mutations, 0);
    });
  }
});

test("delegates can update non-destructive state, while destructive inbox management stays owner-only", async () => {
  const ordinaryCalls = installFetch({ team: [inboxStaff()] });
  const ordinaryRes = makeRes();
  await smsInboxHandler(request("POST", { body: { action: "markRead", ids: ["sms-auto"], read: true } }), ordinaryRes);
  assert.equal(ordinaryRes.statusCode, 200);
  assert.deepEqual(ordinaryRes.body.updatedIds, ["sms-auto"]);
  assert.deepEqual(ordinaryCalls.mutationMethods, ["PATCH"]);
  assert.ok(ordinaryCalls.urls.some((url) => url.includes("select=id,channel,ai")), "mutation selects the OR-filter columns for PostgREST compatibility");

  const mainCalls = installFetch({ team: [inboxStaff({ main: true })] });
  const mainRes = makeRes();
  await smsInboxHandler(request("POST", { body: { action: "markRead", ids: ["sms-main"], read: true } }), mainRes);
  assert.equal(mainRes.statusCode, 200);
  assert.deepEqual(mainRes.body.updatedIds, ["sms-main"]);
  assert.deepEqual(mainCalls.mutationMethods, ["PATCH"]);

  const repliedCalls = installFetch({ team: [inboxStaff({ main: true })] });
  const repliedRes = makeRes();
  await smsInboxHandler(request("POST", { body: { action: "markReplied", ids: ["sms-main"] } }), repliedRes);
  assert.equal(repliedRes.statusCode, 403);
  assert.match(repliedRes.body.error, /only the owner/i);
  assert.equal(repliedCalls.mutations, 0);

  for (const body of [
    { action: "delete", ids: ["sms-auto"] },
    { action: "setKind", ids: ["sms-auto"], kind: "client" },
    { action: "markImported", id: "sms-auto", leadId: "lead-1" },
  ]) {
    const calls = installFetch({ team: [inboxStaff({ main: true })] });
    const res = makeRes();
    await smsInboxHandler(request("POST", { body }), res);
    assert.equal(res.statusCode, 403, body.action);
    assert.match(res.body.error, /owner access/i);
    assert.equal(calls.lookups, 0, body.action);
    assert.equal(calls.mutations, 0, body.action);
  }

  const ownerCalls = installFetch({ team: [ownerStaff()] });
  const ownerRes = makeRes();
  await smsInboxHandler(request("POST", { body: { action: "delete", ids: ["sms-main"] } }), ownerRes);
  assert.equal(ownerRes.statusCode, 200);
  assert.deepEqual(ownerRes.body.deletedIds, ["sms-main"]);
  assert.deepEqual(ownerCalls.mutationMethods, ["DELETE"]);
});

test("private MMS is signed lazily only after exact line authorization", async (t) => {
  const mediaRow = {
    id: "sms-main-media",
    channel: "sms",
    ai: { quoLine: "main" },
    sms_line: "main",
    sms_media: [{ bucket: "sms-media", path: "messages/AC-1/1.jpg", mimeType: "image/jpeg", size: 10 }],
    sms_contact_avatar_path: "",
  };

  const run = async (team) => {
    let signCalls = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.endsWith("/auth/v1/user")) return response({ id: "auth-user-1", email: "tech@example.test" });
      if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
        return response([{ value: JSON.stringify(team) }]);
      }
      if (target.includes("/rest/v1/sps_inbox?") && target.includes("sms_contact_avatar_path")) return response([mediaRow]);
      if (target.includes("/storage/v1/object/sign/sms-media/")) {
        signCalls += 1;
        return response({ signedURL: "/object/sign/sms-media/private-token" });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    };
    const res = makeRes();
    await smsInboxHandler(request("GET", { query: { mediaFor: mediaRow.id } }), res);
    return { res, signCalls };
  };

  await t.test("owner", async () => {
    const { res, signCalls } = await run([ownerStaff()]);
    assert.equal(res.statusCode, 200);
    assert.equal(signCalls, 1);
    assert.equal(res.body.media.sms_media[0].url, "https://supabase.test/storage/v1/object/sign/sms-media/private-token");
  });

  await t.test("automation-only delegate", async () => {
    const { res, signCalls } = await run([inboxStaff()]);
    assert.equal(res.statusCode, 403);
    assert.equal(signCalls, 0);
  });
});
