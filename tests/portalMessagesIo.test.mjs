import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: portalMessagesHandler } = await import("../api/portal-messages.js");

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

function portalClient() {
  return {
    id: "client-1",
    name: "Client One",
    email: "client@example.test",
    auth_user_id: "user-1",
  };
}

function installPortalFetch(messageRows) {
  const messageRequests = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "user-1", email: "client@example.test" });
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_clients")) {
      return response([{ value: JSON.stringify([portalClient()]) }]);
    }
    if (target.includes("/rest/v1/sps_messages?")) {
      messageRequests.push(target);
      return response(messageRows);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  return messageRequests;
}

test("portal unread summary selects only capped message ids", async () => {
  const requests = installPortalFetch([{ id: 11 }, { id: 12 }]);
  const res = makeRes();

  await portalMessagesHandler({
    method: "GET",
    query: { summary: "unread" },
    headers: { authorization: "Bearer client-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { unread: 2, capped: false });
  assert.equal(requests.length, 1);
  const query = new URL(requests[0]).searchParams;
  assert.equal(query.get("select"), "id");
  assert.equal(query.get("client_id"), "eq.client-1");
  assert.equal(query.get("sender"), "eq.staff");
  assert.equal(query.get("read_at"), "is.null");
  assert.equal(query.get("limit"), "100");
  assert.equal(requests[0].includes("body"), false);
});

test("portal unread summary reports when its bounded result is capped", async () => {
  installPortalFetch(Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })));
  const res = makeRes();

  await portalMessagesHandler({
    method: "GET",
    query: { summary: "unread" },
    headers: { authorization: "Bearer client-token" },
  }, res);

  assert.deepEqual(res.body, { unread: 100, capped: true });
});

test("normal portal history loads the newest bounded page and returns it chronologically", async () => {
  const newestFirst = [
    { id: 3, client_id: "client-1", sender: "staff", sender_name: "Taylor", body: "Third", created_at: "2026-07-23T15:03:00Z", read_at: null },
    { id: 2, client_id: "client-1", sender: "client", sender_name: "Client One", body: "Second", created_at: "2026-07-23T15:02:00Z", read_at: null },
    { id: 1, client_id: "client-1", sender: "staff", sender_name: "Taylor", body: "First", created_at: "2026-07-23T15:01:00Z", read_at: null },
  ];
  const requests = installPortalFetch(newestFirst);
  const res = makeRes();

  await portalMessagesHandler({
    method: "GET",
    query: {},
    headers: { authorization: "Bearer client-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.messages.map((message) => message.id), [1, 2, 3]);
  const query = new URL(requests[0]).searchParams;
  assert.equal(query.get("order"), "created_at.desc");
  assert.equal(query.get("limit"), "200");
});
