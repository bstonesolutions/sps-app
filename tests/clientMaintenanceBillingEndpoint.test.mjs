import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: handler } = await import("../api/client-maintenance-billing.js");
const { memberHasCapability } = await import("../api/_staff-auth.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, ok = true, status = 200) => ({
  ok,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

function mockResponse() {
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

const prepaid = {
  version: 1,
  mode: "prepaid",
  coveredFrom: "2026-08-01",
  coveredThrough: "2026-12-31",
  sourceInvoiceId: "invoice-prepaid",
};

const request = (maintenanceBilling = prepaid) => ({
  method: "POST",
  headers: { authorization: "Bearer staff-token" },
  body: { clientId: "c1", maintenanceBilling },
});

test("maintenance billing requires invoice-create accounting access", () => {
  assert.equal(memberHasCapability({ role: "field", tabAccess: { invoices: "view" } }, "invoiceCreate"), false);
  assert.equal(memberHasCapability({ role: "custom", tabAccess: { invoices: "edit" }, fine: { invoiceCreate: false } }, "invoiceCreate"), false);
  assert.equal(memberHasCapability({ role: "custom", tabAccess: { invoices: "edit" }, fine: { invoiceCreate: true } }, "invoiceCreate"), true);
  assert.equal(memberHasCapability({ role: "owner", tabAccess: { invoices: "hidden" } }, "invoiceCreate"), true);
});

test("unauthorized staff are rejected before client or billing state is read", async () => {
  let businessReads = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "staff@example.com" });
    if (href.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ email: "staff@example.com", role: "field", tabAccess: { invoices: "view", clients: "edit" } }]) }]);
    }
    businessReads += 1;
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await handler(request(), res);

  assert.equal(res.statusCode, 403);
  assert.equal(businessReads, 0);
});

test("authorized accounting staff update the client mirror and protected ledger atomically", async () => {
  const team = [{
    email: "staff@example.com",
    role: "custom",
    tabAccess: { invoices: "edit", clients: "edit" },
    fine: { invoiceCreate: true },
  }];
  const state = {
    sps_clients: {
      value: [
        { id: "c1", name: "Generic Client", phone: "555-0100", history: [{ id: "visit-1" }] },
        { id: "c2", name: "Another Client", maintenanceBilling: { ...prepaid, sourceInvoiceId: "other" } },
      ],
      version: 4,
    },
    sps_maintenance_billing: {
      value: { version: 1, policies: { c2: { ...prepaid, sourceInvoiceId: "other" } } },
      version: 2,
    },
  };
  let batch = null;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "staff@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      const key = decodeURIComponent((href.match(/key=eq\.([^&]+)/) || [])[1] || "");
      const row = state[key];
      return response(row ? [{ key, value: JSON.stringify(row.value), version: row.version, updated_at: null }] : []);
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batch = JSON.parse(options.body).p_operations;
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await handler(request(), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(batch.map((operation) => operation.key), ["sps_clients", "sps_maintenance_billing"]);
  const clients = JSON.parse(batch.find((operation) => operation.key === "sps_clients").value);
  const store = JSON.parse(batch.find((operation) => operation.key === "sps_maintenance_billing").value);
  assert.equal(clients[0].phone, "555-0100");
  assert.deepEqual(clients[0].history, [{ id: "visit-1" }]);
  assert.deepEqual(clients[0].maintenanceBilling, prepaid);
  assert.deepEqual(clients[1], state.sps_clients.value[1], "another client is untouched");
  assert.deepEqual(store.policies.c1, prepaid);
  assert.deepEqual(store.policies.c2, state.sps_maintenance_billing.value.policies.c2);
});

test("a CAS retry re-reads the winning client row and policy removal preserves concurrent edits", async () => {
  const team = [{ email: "owner@example.com", role: "owner" }];
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Before", maintenanceBilling: prepaid }], version: 2 },
    sps_maintenance_billing: { value: { version: 1, policies: { c1: prepaid } }, version: 3 },
  };
  let batches = 0;
  let finalBatch = null;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-owner", email: "owner@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      const key = decodeURIComponent((href.match(/key=eq\.([^&]+)/) || [])[1] || "");
      const row = state[key];
      return response([{ key, value: JSON.stringify(row.value), version: row.version, updated_at: null }]);
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batches += 1;
      if (batches === 1) {
        state.sps_clients = { value: [{ id: "c1", name: "Concurrent winner", maintenanceBilling: prepaid }], version: 3 };
        return response([{ applied: false, outcome: "conflict", conflict_key: "sps_clients", current_versions: {} }]);
      }
      finalBatch = JSON.parse(options.body).p_operations;
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await handler(request(null), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(batches, 2);
  const clients = JSON.parse(finalBatch.find((operation) => operation.key === "sps_clients").value);
  const store = JSON.parse(finalBatch.find((operation) => operation.key === "sps_maintenance_billing").value);
  assert.equal(clients[0].name, "Concurrent winner");
  assert.equal(Object.prototype.hasOwnProperty.call(clients[0], "maintenanceBilling"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(store.policies, "c1"), false);
  assert.equal(finalBatch.find((operation) => operation.key === "sps_clients").expected_version, 3);
});

test("invalid partial-month coverage is rejected before any shared state mutation", async () => {
  const team = [{ email: "owner@example.com", role: "owner" }];
  let businessRequests = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-owner", email: "owner@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    businessRequests += 1;
    throw new Error(`Unexpected fetch: ${href}`);
  };
  const res = mockResponse();
  await handler(request({
    version: 1,
    mode: "prepaid",
    coveredFrom: "2026-08-15",
    coveredThrough: "2026-09-14",
  }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /first day of a month/i);
  assert.equal(businessRequests, 0);
});
