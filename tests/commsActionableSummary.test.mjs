import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: inboxHandler } = await import("../api/inbox.js");
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

test("the owner actionable summary groups text threads and ignores ordinary unread email", async () => {
  const inboxRequests = [];
  const rows = [
    {
      id: "sms-1",
      channel: "sms",
      sms_line: "main",
      sms_peer_phone: "+15550100101",
      sms_direction: "incoming",
      body_text: "First",
      created_at: "2026-08-29T12:00:00Z",
      read: false,
    },
    {
      id: "sms-2",
      channel: "sms",
      sms_line: "main",
      sms_peer_phone: "+15550100101",
      sms_direction: "incoming",
      body_text: "Second",
      created_at: "2026-08-29T12:01:00Z",
      read: false,
    },
    { id: "bill", channel: "email", kind: "bill", subject: "Invoice payment due tomorrow", read: false, created_at: "2026-08-29T11:00:00Z" },
    { id: "noise", channel: "email", kind: "other", read: false, created_at: "2026-08-29T10:00:00Z" },
  ];

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return response({ id: "auth-owner", email: "owner@example.test" });
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ id: "owner", email: "owner@example.test", role: "owner" }]) }]);
    }
    if (target.includes("/rest/v1/sps_inbox?")) {
      inboxRequests.push(target);
      return response(rows);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const res = makeRes();
  await inboxHandler({
    method: "GET",
    query: { summary: "actionable" },
    headers: { authorization: "Bearer owner-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    actionable: 2,
    count: 2,
    capped: false,
    counts: { total: 2, texts: 1, leads: 0, bills: 1, clients: 0, failures: 0 },
  });
  assert.equal(inboxRequests.length, 1);
  const query = new URL(inboxRequests[0]).searchParams;
  assert.equal(query.get("limit"), "200");
  assert.equal(query.get("order"), "created_at.desc");
  assert.notEqual(query.get("select"), "*");
  assert.match(query.get("select"), /body_text/);
  assert.match(query.get("select"), /sms_direction/);
});

test("the staff actionable summary stays scoped to authorized text lines", async () => {
  const inboxRequests = [];
  const rows = [
    {
      id: "auto-1",
      channel: "sms",
      ai: { quoLine: "automation" },
      sms_line: "automation",
      sms_peer_phone: "+15550100102",
      sms_direction: "incoming",
      body_text: "First",
      created_at: "2026-08-29T12:00:00Z",
      read: false,
    },
    {
      id: "auto-2",
      channel: "sms",
      ai: { quoLine: "automation" },
      sms_line: "automation",
      sms_peer_phone: "+15550100102",
      sms_direction: "incoming",
      body_text: "Second",
      created_at: "2026-08-29T12:01:00Z",
      read: false,
    },
    {
      id: "auto-failed",
      channel: "sms",
      ai: { quoLine: "automation" },
      sms_line: "automation",
      sms_peer_phone: "+15550100103",
      sms_direction: "outgoing",
      sms_status: "delivery_failed",
      body_text: "Report",
      created_at: "2026-08-29T12:02:00Z",
      read: true,
    },
    {
      id: "main-private",
      channel: "sms",
      ai: { quoLine: "main" },
      sms_line: "main",
      sms_peer_phone: "+15550100104",
      sms_direction: "incoming",
      body_text: "Private",
      created_at: "2026-08-29T12:03:00Z",
      read: false,
    },
    { id: "private-email", channel: "email", kind: "client", read: false },
  ];

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return response({ id: "auth-staff", email: "tech@example.test" });
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{
        value: JSON.stringify([{
          id: "staff-1",
          email: "tech@example.test",
          role: "field",
          tabAccess: { comms: "view" },
          fine: { commsTextInbox: true },
        }]),
      }]);
    }
    if (target.includes("/rest/v1/sps_inbox?")) {
      inboxRequests.push(target);
      return response(rows);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const res = makeRes();
  await smsInboxHandler({
    method: "GET",
    query: { summary: "actionable" },
    headers: { authorization: "Bearer staff-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    actionable: 2,
    count: 2,
    capped: false,
    counts: { total: 2, texts: 1, leads: 0, bills: 0, clients: 0, failures: 1 },
    access: { automation: true, main: false },
  });
  assert.equal(inboxRequests.length, 1);
  const query = new URL(inboxRequests[0]).searchParams;
  assert.equal(query.get("channel"), "eq.sms");
  assert.match(query.get("or"), /quoLine\.eq\.automation/);
  assert.equal(query.get("limit"), "200");
  assert.notEqual(query.get("select"), "*");
});
