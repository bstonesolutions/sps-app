import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: inboxHandler } = await import("../api/inbox.js");

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

test("unread summary authenticates the owner and reads IDs without email bodies", async () => {
  const databaseRequests = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "owner-auth-id", email: "owner@example.test" });
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ id: "owner-1", email: "owner@example.test", role: "owner" }]) }]);
    }
    if (target.includes("/rest/v1/sps_inbox?")) {
      databaseRequests.push(target);
      return response([{ id: "mail-1" }, { id: "mail-2" }]);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const res = makeRes();
  await inboxHandler({
    method: "GET",
    query: { summary: "unread" },
    headers: { authorization: "Bearer owner-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, unread: 2, capped: false });
  assert.equal(databaseRequests.length, 1);
  const query = new URL(databaseRequests[0]).searchParams;
  assert.equal(query.get("select"), "id");
  assert.equal(query.get("limit"), "100");
  assert.equal(query.get("or"), "(read.eq.false,read.is.null)");
  assert.equal(databaseRequests[0].includes("select=*"), false);
});

test("unread summary caps work once the navigation badge is already 99+", async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return response({ id: "owner-auth-id", email: "owner@example.test" });
    if (target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ id: "owner-1", email: "owner@example.test", role: "owner" }]) }]);
    }
    if (target.includes("/rest/v1/sps_inbox?")) {
      return response(Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) })));
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const res = makeRes();
  await inboxHandler({
    method: "GET",
    query: { summary: "unread" },
    headers: { authorization: "Bearer owner-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, unread: 100, capped: true });
});
