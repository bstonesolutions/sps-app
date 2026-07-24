import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

function request(method = "GET", { query = {}, body = {} } = {}) {
  return {
    method,
    query,
    body,
    headers: { authorization: "Bearer verified-staff-token" },
  };
}

const automationStaff = () => ({
  id: "team-member-1",
  email: "tech@example.test",
  role: "field",
  tabAccess: { comms: "edit" },
  fine: { commsTextInbox: true },
});

const ownerStaff = () => ({
  id: "team-owner-1",
  email: "tech@example.test",
  role: "owner",
});

function idsFromUrl(target) {
  const raw = new URL(target).searchParams.get("id") || "";
  const match = /^in\.\((.*)\)$/.exec(raw);
  return match ? match[1].split(",").map(decodeURIComponent) : [];
}

function eqValue(target, key) {
  const raw = new URL(target).searchParams.get(key) || "";
  return raw.startsWith("eq.") ? raw.slice(3) : raw;
}

function installFetch({
  team = [automationStaff()],
  inboxRows = [],
  preferenceRows = [],
  preferenceTableReady = true,
} = {}) {
  const calls = {
    urls: [],
    preferenceReads: 0,
    preferenceWrites: [],
    preferenceDeletes: [],
    inboxLookups: 0,
  };

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || "GET").toUpperCase();
    calls.urls.push(target);

    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "auth-user-1", email: "tech@example.test" });
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify(team) }]);
    }
    if (target.includes("/rest/v1/sps_sms_thread_preferences?")) {
      if (!preferenceTableReady) return response({ message: "relation does not exist" }, { ok: false, status: 404 });
      if (method === "GET") {
        calls.preferenceReads += 1;
        // Deliberately ignore the URL filters. The endpoint must still isolate the verified user
        // and re-check their current line grants after a service-role read.
        return response(preferenceRows);
      }
      if (method === "POST") {
        const payload = JSON.parse(String(options.body || "[]"));
        calls.preferenceWrites.push(...payload);
        return response(payload.map((row) => ({
          user_id: row.user_id,
          thread_key: row.thread_key,
          pinned_at: row.pinned_at,
        })));
      }
      if (method === "DELETE") {
        const userId = eqValue(target, "user_id");
        const threadKey = eqValue(target, "thread_key");
        calls.preferenceDeletes.push({ userId, threadKey });
        return response(preferenceRows.filter(
          (row) => row.user_id === userId && row.thread_key === threadKey,
        ).map(({ user_id, thread_key }) => ({ user_id, thread_key })));
      }
    }
    if (
      target.includes("/rest/v1/sps_inbox?")
      && target.includes("select=id,channel,ai,sms_line,from_phone,sms_peer_phone,quo_conversation_id,body_text")
    ) {
      calls.inboxLookups += 1;
      const wanted = new Set(idsFromUrl(target));
      return response(inboxRows.filter((row) => wanted.has(row.id)));
    }
    throw new Error(`Unexpected fetch: ${method} ${target}`);
  };

  return calls;
}

test("personal pin reads are isolated to the verified user and currently authorized text line", async () => {
  const preferences = [
    {
      user_id: "auth-user-1",
      thread_key: "automation|phone:5551110001",
      pinned_at: "2026-07-24T12:00:00.000Z",
    },
    {
      user_id: "auth-user-1",
      thread_key: "main|phone:5551110002",
      pinned_at: "2026-07-24T11:00:00.000Z",
    },
    {
      user_id: "another-auth-user",
      thread_key: "automation|phone:5551110003",
      pinned_at: "2026-07-24T10:00:00.000Z",
    },
    {
      user_id: "auth-user-1",
      thread_key: "unexpected|phone:5551110004",
      pinned_at: "2026-07-24T09:00:00.000Z",
    },
  ];
  const calls = installFetch({ preferenceRows: preferences });
  const res = makeRes();

  await smsInboxHandler(request("GET", { query: { threadPrefs: "1" } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.preferences, {
    "automation|phone:5551110001": {
      pinned: true,
      pinnedAt: "2026-07-24T12:00:00.000Z",
    },
  });
  assert.equal(calls.preferenceReads, 1);
  assert.ok(
    calls.urls.some((url) => new URL(url).searchParams.get("user_id") === "eq.auth-user-1"),
    "the database read must also be scoped to the verified auth user",
  );
});

test("a missing preference table degrades to an empty pin set without breaking the inbox", async () => {
  installFetch({ preferenceTableReady: false });
  const res = makeRes();

  await smsInboxHandler(request("GET", { query: { threadPrefs: "1" } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.preferences, {});
  assert.equal(res.body.setupRequired, true);
});

test("an authorized employee pins their own conversation using a server-derived thread key", async () => {
  const inboxRows = [{
    id: "sms-anchor",
    channel: "sms",
    sms_line: "automation",
    sms_peer_phone: "+15551110001",
    from_phone: "+15551110001",
    ai: { quoLine: "automation" },
  }];
  const calls = installFetch({ inboxRows });
  const res = makeRes();

  await smsInboxHandler(request("POST", {
    body: {
      action: "setPinned",
      anchorId: "sms-anchor",
      pinned: true,
      userId: "forged-browser-user",
      threadKey: "main|phone:5555999999",
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.threadKey, "automation|phone:5551110001");
  assert.equal(res.body.pinned, true);
  assert.equal(calls.inboxLookups, 1);
  assert.equal(calls.preferenceWrites.length, 1);
  assert.equal(calls.preferenceWrites[0].user_id, "auth-user-1");
  assert.equal(calls.preferenceWrites[0].thread_key, "automation|phone:5551110001");
});

test("a pin cannot cross an employee's text-line permission boundary", async () => {
  const inboxRows = [{
    id: "sms-main",
    channel: "sms",
    sms_line: "main",
    sms_peer_phone: "+15551110002",
    from_phone: "+15551110002",
    ai: { quoLine: "main" },
  }];
  const calls = installFetch({ inboxRows });
  const res = makeRes();

  await smsInboxHandler(request("POST", {
    body: { action: "setPinned", anchorId: "sms-main", pinned: true },
  }), res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /unavailable with your current permissions/i);
  assert.equal(calls.preferenceWrites.length, 0);
});

test("unpinning deletes only the verified user's exact line-scoped conversation and is idempotent", async () => {
  const inboxRows = [{
    id: "sms-main",
    channel: "sms",
    sms_line: "main",
    sms_peer_phone: "+15551110002",
    from_phone: "+15551110002",
    ai: { quoLine: "main" },
  }];
  const preferenceRows = [{
    user_id: "another-auth-user",
    thread_key: "main|phone:5551110002",
    pinned_at: "2026-07-24T12:00:00.000Z",
  }];
  const calls = installFetch({ team: [ownerStaff()], inboxRows, preferenceRows });
  const res = makeRes();

  await smsInboxHandler(request("POST", {
    body: { action: "setPinned", anchorId: "sms-main", pinned: false },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.threadKey, "main|phone:5551110002");
  assert.equal(res.body.pinned, false);
  assert.equal(res.body.pinnedAt, null);
  assert.deepEqual(calls.preferenceDeletes, [{
    userId: "auth-user-1",
    threadKey: "main|phone:5551110002",
  }]);
});

test("pin mutations fail clearly until the preference setup SQL has run", async () => {
  const inboxRows = [{
    id: "sms-anchor",
    channel: "sms",
    sms_line: "automation",
    sms_peer_phone: "+15551110001",
    ai: { quoLine: "automation" },
  }];
  installFetch({ inboxRows, preferenceTableReady: false });
  const res = makeRes();

  await smsInboxHandler(request("POST", {
    body: { action: "setPinned", anchorId: "sms-anchor", pinned: true },
  }), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /SMS-THREAD-PREFERENCES-RUN\.sql/i);
});

test("the preference migration keeps the table server-only with RLS forced", async () => {
  const sql = await readFile(
    new URL("../SMS-THREAD-PREFERENCES-RUN.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /references auth\.users\s*\(id\)\s*on delete cascade/i);
  assert.match(sql, /primary key\s*\(user_id,\s*thread_key\)/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /revoke all on table public\.sps_sms_thread_preferences[\s\S]*from public,\s*anon,\s*authenticated/i);
  assert.match(sql, /grant select,\s*insert,\s*update,\s*delete on table public\.sps_sms_thread_preferences[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /create policy/i);
});
