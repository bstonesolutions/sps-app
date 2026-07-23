import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: portalDataHandler } = await import("../api/portal-data.js");

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

const clients = [
  { id: "client-1", name: "Client One", email: "client@example.test", auth_user_id: "user-1", history: [] },
  { id: "client-2", name: "Client Two", email: "other@example.test", auth_user_id: "user-2", history: [] },
];

test("portal data reuses its authorized clients snapshot and still filters other clients' records", async () => {
  const appStateRequests = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "user-1", email: "client@example.test" });
    }
    if (target.includes("/rest/v1/app_state?")) {
      appStateRequests.push(target);
      const query = new URL(target).searchParams;
      if (query.get("key") === "eq.sps_clients") {
        return response([{ value: JSON.stringify(clients) }]);
      }
      const requested = query.get("key") || "";
      assert.match(requested, /^in\.\(/);
      assert.equal(requested.includes("sps_clients"), false);
      return response([
        { key: "sps_invoices", value: JSON.stringify([
          { id: "invoice-own", clientId: "client-1", status: "sent", number: "1001", lineItems: [] },
          { id: "invoice-other", clientId: "client-2", status: "sent", number: "1002", lineItems: [] },
        ]) },
        { key: "sps_schedule", value: JSON.stringify([]) },
        { key: "sps_estimates", value: JSON.stringify([]) },
        { key: "sps_branding", value: JSON.stringify({ companyName: "SPS" }) },
        { key: "sps_invoicing", value: JSON.stringify({}) },
        { key: "sps_team", value: JSON.stringify([]) },
        { key: "sps_arrivals", value: JSON.stringify({}) },
        { key: "sps_completed", value: JSON.stringify({}) },
        { key: "sps_enroute", value: JSON.stringify({}) },
      ]);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const res = makeRes();
  await portalDataHandler({
    method: "GET",
    query: {},
    headers: { authorization: "Bearer client-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.client.id, "client-1");
  assert.deepEqual(res.body.invoices.map((invoice) => invoice.id), ["invoice-own"]);
  assert.equal(appStateRequests.filter((url) => new URL(url).searchParams.get("key") === "eq.sps_clients").length, 1);
  assert.equal(appStateRequests.length, 2);
});

test("ambiguous portal bindings fail before any broader state read", async () => {
  let bulkReads = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "user-1", email: "client@example.test" });
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_clients")) {
      return response([{ value: JSON.stringify([
        clients[0],
        { ...clients[0], id: "duplicate-client" },
      ]) }]);
    }
    if (target.includes("/rest/v1/app_state?")) {
      bulkReads += 1;
      return response([]);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const res = makeRes();
  await portalDataHandler({
    method: "GET",
    query: {},
    headers: { authorization: "Bearer client-token" },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /more than one client record/i);
  assert.equal(bulkReads, 0);
});
