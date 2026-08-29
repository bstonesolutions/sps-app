import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: handler } = await import("../api/maintenance-payment-ledger.js");

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

function requestedStateKeys(href) {
  const equals = href.match(/key=eq\.([^&]+)/);
  if (equals) return [decodeURIComponent(equals[1])];
  const included = href.match(/key=in\.\(([^)]*)\)/);
  return included && included[1]
    ? included[1].split(",").map((key) => decodeURIComponent(key))
    : [];
}

function stateRows(href, state) {
  return requestedStateKeys(href).flatMap((key) => {
    const row = state[key];
    return row ? [{ key, value: JSON.stringify(row.value), version: row.version, updated_at: null }] : [];
  });
}

const ownerTeam = [{ id: "owner-1", email: "owner@example.com", role: "owner" }];
const canonicalClient = {
  id: "c1",
  name: "Generic Client",
  qbId: "qb-c1",
  planFreq: "Monthly",
  monthlyRate: 229,
};
const canonicalInvoice = {
  id: "iv1",
  qbId: "qb-iv1",
  number: "2050",
  clientId: "c1",
  clientName: "Generic Client",
  total: 687,
  balance: 687,
  status: "Sent",
};

function authenticatedStateFetch({ team = ownerTeam, state, onBatch } = {}) {
  return async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-owner", email: team[0]?.email || "owner@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) return response(stateRows(href, state));
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      const operations = JSON.parse(options.body).p_operations;
      if (onBatch) onBatch(operations);
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
}

test("invoice viewers can load the protected ledger and v1 policies upgrade to v2", async () => {
  const policy = {
    version: 1,
    mode: "prepaid",
    coveredFrom: "2026-08-01",
    coveredThrough: "2026-08-31",
    sourceInvoiceId: "prepay-1",
  };
  const state = {
    sps_maintenance_billing: { value: { version: 1, policies: { c1: policy } }, version: 7 },
  };
  globalThis.fetch = authenticatedStateFetch({
    team: [{ email: "viewer@example.com", role: "custom", tabAccess: { invoices: "view" } }],
    state,
  });

  const res = mockResponse();
  await handler({ method: "GET", headers: { authorization: "Bearer viewer-token" } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.body.version, 7);
  assert.equal(res.body.maintenancePaymentLedger.version, 2);
  assert.equal(res.body.maintenancePaymentLedger.allocations.c1["2026-08"].status, "prepaid");
});

test("staff without invoice access are rejected before the ledger is read", async () => {
  let ledgerReads = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-field", email: "field@example.com" });
    if (href.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ email: "field@example.com", role: "field", tabAccess: { invoices: "hidden" } }]) }]);
    }
    if (href.includes("sps_maintenance_billing")) ledgerReads += 1;
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await handler({ method: "GET", headers: { authorization: "Bearer field-token" } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(ledgerReads, 0);
});

test("assign uses canonical invoice evidence, ignores spoofed totals, and fences clients and invoices", async () => {
  const state = {
    sps_clients: { value: [canonicalClient], version: 3 },
    sps_invoices: { value: [canonicalInvoice], version: 8 },
    sps_maintenance_billing: { value: { version: 2, policies: {}, allocations: {} }, version: 4 },
  };
  let batch = null;
  globalThis.fetch = authenticatedStateFetch({ state, onBatch(operations) { batch = operations; } });

  const res = mockResponse();
  await handler({
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
    body: {
      action: "assign",
      clientId: "c1",
      invoiceId: "iv1",
      monthKeys: ["2026-08", "2026-09", "2026-10"],
      note: "Quarterly payment",
      total: 999999,
      expectedCents: 1,
      status: "paid",
    },
  }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.invoice.totalCents, 68700);
  const written = JSON.parse(batch.find((operation) => operation.key === "sps_maintenance_billing").value);
  for (const month of ["2026-08", "2026-09", "2026-10"]) {
    assert.equal(written.allocations.c1[month].status, "due");
    assert.equal(written.allocations.c1[month].allocatedCents, 22900);
    assert.equal(written.allocations.c1[month].expectedCents, 22900);
  }
  assert.deepEqual(batch.find((operation) => operation.key === "sps_clients"), {
    key: "sps_clients",
    expected_version: 3,
    check_only: true,
  });
  assert.deepEqual(batch.find((operation) => operation.key === "sps_invoices"), {
    key: "sps_invoices",
    expected_version: 8,
    check_only: true,
  });
});

test("assign rejects an invoice linked to a different client without writing", async () => {
  const state = {
    sps_clients: { value: [canonicalClient, { id: "c2", name: "Other Client" }], version: 1 },
    sps_invoices: { value: [{ ...canonicalInvoice, clientId: "c2" }], version: 1 },
    sps_maintenance_billing: { value: { version: 2, policies: {}, allocations: {} }, version: 1 },
  };
  let writes = 0;
  globalThis.fetch = authenticatedStateFetch({ state, onBatch() { writes += 1; } });

  const res = mockResponse();
  await handler({
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
    body: { action: "assign", clientId: "c1", invoiceId: "iv1", monthKeys: ["2026-08"] },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /not linked/i);
  assert.equal(writes, 0);
});

test("accounting staff can waive selected months without inventing invoice evidence", async () => {
  const state = {
    sps_clients: { value: [canonicalClient], version: 2 },
    sps_invoices: { value: [canonicalInvoice], version: 5 },
    sps_maintenance_billing: { value: { version: 2, policies: {}, allocations: {} }, version: 3 },
  };
  let batch = null;
  globalThis.fetch = authenticatedStateFetch({ state, onBatch(operations) { batch = operations; } });

  const res = mockResponse();
  await handler({
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
    body: {
      action: "assign",
      actionType: "waived",
      clientId: "c1",
      monthKeys: ["2026-08", "2026-09"],
      note: "Courtesy coverage",
      total: 999999,
    },
  }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.actionType, "waived");
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, "invoice"), false);
  const written = JSON.parse(batch.find((operation) => operation.key === "sps_maintenance_billing").value);
  for (const month of ["2026-08", "2026-09"]) {
    assert.equal(written.allocations.c1[month].status, "waived");
    assert.equal(written.allocations.c1[month].allocatedCents, 0);
    assert.equal(written.allocations.c1[month].expectedCents, 22900);
    assert.equal(written.allocations.c1[month].sources[0].kind, "waiver");
  }
});

test("clearing one invoice source preserves policies and other invoice evidence", async () => {
  const policy = {
    version: 1,
    mode: "prepaid",
    coveredFrom: "2025-08-01",
    coveredThrough: "2025-08-31",
  };
  const secondInvoice = {
    ...canonicalInvoice,
    id: "iv2",
    qbId: "qb-iv2",
    number: "2051",
    total: 200,
  };
  const state = {
    sps_clients: { value: [canonicalClient], version: 4 },
    sps_invoices: { value: [canonicalInvoice, secondInvoice], version: 9 },
    sps_maintenance_billing: {
      value: {
        version: 2,
        policies: { c1: policy },
        allocations: {
          c1: {
            "2026-08": {
              status: "paid",
              sources: [
                { kind: "invoice", invoiceId: "iv1", qbInvoiceId: "qb-iv1", invoiceNumber: "2050", amountCents: 10000 },
                { kind: "invoice", invoiceId: "iv2", qbInvoiceId: "qb-iv2", invoiceNumber: "2051", amountCents: 20000 },
              ],
              allocatedCents: 30000,
            },
          },
        },
      },
      version: 5,
    },
  };
  let batch = null;
  globalThis.fetch = authenticatedStateFetch({ state, onBatch(operations) { batch = operations; } });

  const res = mockResponse();
  await handler({
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
    body: { action: "clear", clientId: "c1", invoiceId: "iv1", monthKeys: ["2026-08"] },
  }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const written = JSON.parse(batch.find((operation) => operation.key === "sps_maintenance_billing").value);
  assert.deepEqual(written.policies, { c1: policy });
  assert.equal(written.allocations.c1["2026-08"].sources.length, 1);
  assert.equal(written.allocations.c1["2026-08"].sources[0].invoiceId, "iv2");
  assert.equal(written.allocations.c1["2026-08"].allocatedCents, 20000);
});
