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

function installFetch({ team, listRows = rows, threadMeta = {} } = {}) {
  let savedThreadMeta = { ...threadMeta };
  let threadMetaVersion = Object.keys(savedThreadMeta).length ? 1 : 0;
  const calls = { list: 0, lookups: 0, mutations: 0, mutationMethods: [], urls: [], threadMetaWrites: 0, threadMeta: () => savedThreadMeta };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.urls.push(target);
    if (target.endsWith("/auth/v1/user")) return response({ id: "auth-user-1", email: "tech@example.test" });
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify(team || [inboxStaff()]) }]);
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_sms_thread_meta")) {
      return response(threadMetaVersion ? [{ key: "sps_sms_thread_meta", value: JSON.stringify(savedThreadMeta), version: threadMetaVersion, updated_at: "2026-07-21T12:00:00Z" }] : []);
    }
    if (target.endsWith("/rest/v1/rpc/sps_app_state_cas") && options.method === "POST") {
      const body = JSON.parse(String(options.body || "{}"));
      const expected = Number(body.p_expected_version);
      if (expected !== threadMetaVersion) return response({ applied: false, outcome: "conflict", current_version: threadMetaVersion });
      savedThreadMeta = JSON.parse(String(body.p_value || "{}"));
      threadMetaVersion += 1;
      calls.threadMetaWrites += 1;
      return response({ applied: true, outcome: expected === 0 ? "inserted" : "updated", current_version: threadMetaVersion, changed_at: "2026-07-21T12:00:01Z" });
    }
    if (target.includes("/rest/v1/sps_inbox?") && ["PATCH", "DELETE"].includes(options.method)) {
      calls.mutations += 1;
      calls.mutationMethods.push(options.method);
      const wanted = new Set(idsFromUrl(target));
      return response(listRows.filter((row) => wanted.has(row.id)).map(({ id, channel, ai, sms_line, from_phone, sms_peer_phone, quo_conversation_id, body_text }) => ({ id, channel, ai, sms_line, from_phone, sms_peer_phone, quo_conversation_id, body_text })));
    }
    if (target.includes("/rest/v1/sps_inbox?") && target.includes("select=id,channel,ai")) {
      if (target.includes("read=not.is.true")) {
        return response(listRows.filter((row) => row.read !== true).map(({ id, channel, ai }) => ({ id, channel, ai })));
      }
      calls.lookups += 1;
      const wanted = new Set(idsFromUrl(target));
      return response(listRows.filter((row) => wanted.has(row.id)).map(({ id, channel, ai, sms_line, from_phone, sms_peer_phone, quo_conversation_id, body_text }) => ({ id, channel, ai, sms_line, from_phone, sms_peer_phone, quo_conversation_id, body_text })));
    }
    if (target.includes("/rest/v1/sps_inbox?") && target.includes("select=*")) {
      calls.list += 1;
      // Deliberately return rows outside the PostgREST predicate. The endpoint must still apply its
      // fail-closed serializer filter before anything reaches a staff browser.
      const wanted = new Set(idsFromUrl(target));
      return response(wanted.size ? listRows.filter((row) => wanted.has(row.id)) : listRows);
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

test("the owner categorizes one durable conversation by its authorized anchor", async () => {
  const conversationRows = [
    { id: "sms-main", channel: "sms", from_phone: "+15551110003", sms_peer_phone: "+15551110003", sms_line: "main", ai: { quoLine: "main" } },
  ];
  const calls = installFetch({ team: [ownerStaff()], listRows: conversationRows });
  const writeRes = makeRes();
  await smsInboxHandler(request("POST", { body: { action: "setThreadKind", id: "sms-main", kind: "bill" } }), writeRes);

  assert.equal(writeRes.statusCode, 200);
  assert.equal(writeRes.body.threadKey, "main|phone:5551110003");
  assert.equal(writeRes.body.meta.kind, "bill");
  assert.equal(calls.threadMetaWrites, 1);
  assert.equal(calls.threadMeta()["main|phone:5551110003"].kind, "bill");

  const readRes = makeRes();
  await smsInboxHandler(request("GET", { query: { threadMeta: "1" } }), readRes);
  assert.equal(readRes.statusCode, 200);
  assert.equal(readRes.body.threads["main|phone:5551110003"].kind, "bill");
});

test("a delegated text-inbox permission cannot categorize a conversation", async () => {
  const calls = installFetch({ team: [inboxStaff({ main: true })] });
  const res = makeRes();
  await smsInboxHandler(request("POST", { body: { action: "setThreadKind", id: "sms-main", kind: "lead" } }), res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /owner access/i);
  assert.equal(calls.threadMetaWrites, 0);
});

test("an authorized conversation anchor hydrates older rows for only its exact line and peer", async () => {
  const conversationRows = [
    { id: "sms-new", channel: "sms", from_phone: "+15551110001", sms_peer_phone: "+15551110001", sms_line: "automation", sms_direction: "incoming", created_at: "2026-07-21T12:00:00Z", read: false, ai: { quoLine: "automation" } },
    { id: "sms-old", channel: "sms", from_phone: "+15551110001", sms_peer_phone: "+15551110001", sms_line: "automation", sms_direction: "outgoing", created_at: "2026-07-20T12:00:00Z", read: true, ai: { quoLine: "automation" } },
    { id: "sms-other-peer", channel: "sms", from_phone: "+15551110002", sms_peer_phone: "+15551110002", sms_line: "automation", sms_direction: "incoming", created_at: "2026-07-21T11:00:00Z", read: false, ai: { quoLine: "automation" } },
    { id: "sms-main-same-peer", channel: "sms", from_phone: "+15551110001", sms_peer_phone: "+15551110001", sms_line: "main", sms_direction: "incoming", created_at: "2026-07-21T10:00:00Z", read: false, ai: { quoLine: "main" } },
    { id: "private-email", channel: "email", from_email: "private@example.test", created_at: "2026-07-21T09:00:00Z", read: false, ai: {} },
  ];
  const calls = installFetch({ team: [inboxStaff()], listRows: conversationRows });
  const res = makeRes();
  await smsInboxHandler(request("GET", { query: { conversationFor: "sms-new", limit: "200" } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rows.map((row) => row.id), ["sms-new", "sms-old"]);
  assert.equal(res.body.hasMore, false);
  assert.equal(calls.list, 2, "one anchored authorization read plus one scoped history read");
  assert.ok(calls.urls.some((url) => url.includes("sms_line=eq.automation") && url.includes("sms_peer_phone=eq.%2B15551110001")));
});

test("a conversation anchor cannot hydrate a text line the employee cannot access", async () => {
  const calls = installFetch({ team: [inboxStaff()] });
  const res = makeRes();
  await smsInboxHandler(request("GET", { query: { conversationFor: "sms-main" } }), res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /unavailable with your current permissions/i);
  assert.equal(calls.list, 1, "the endpoint must stop after the unauthorized anchor read");
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
