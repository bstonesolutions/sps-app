import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.CLIENT_MAINTENANCE_BILLING_TIMEOUT_MS = "250";

const { default: handler, config } = await import("../api/client-maintenance-billing.js");
const { memberHasCapability } = await import("../api/_staff-auth.js");
const originalFetch = globalThis.fetch;
const originalError = console.error;
afterEach(() => { globalThis.fetch = originalFetch; console.error = originalError; });

const response = (body, ok = true, status = 200) => ({
  ok, status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});
const mockResponse = () => ({
  statusCode: 200, body: null, headers: {},
  setHeader(name, value) { this.headers[name] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end() { return this; },
});
const prepaid = {
  version: 1, mode: "prepaid", coveredFrom: "2026-08-01", coveredThrough: "2026-12-31",
  sourceInvoiceId: "historical-invoice-2025", sourceInvoiceNumber: "INV-2025-718",
};
const request = (maintenanceBilling = prepaid) => ({
  method: "POST", headers: { authorization: "Bearer staff-token" },
  body: { clientId: "c1", maintenanceBilling },
});
const clone = (value) => structuredClone(value);
const projection = (client) => client ? {
  id: client.id, name: client.name,
  ...(Object.hasOwn(client, "maintenanceBilling") ? { maintenanceBilling: clone(client.maintenanceBilling) } : {}),
} : null;
function initialState() {
  return {
    clientsVersion: 4, billingVersion: 2, billingExists: true,
    clients: [
      { id: "c1", name: "Example Client", phone: "555-0100", history: [{ id: "visit-1", notes: "Unchanged history" }] },
      { id: "c2", name: "Another Client", maintenanceBilling: { ...prepaid, sourceInvoiceId: "other" } },
    ],
    ledger: {
      version: 2, policies: { c2: { ...prepaid, sourceInvoiceId: "other" } },
      allocations: { c2: { "2026-08": {
        status: "paid", sources: [{ kind: "invoice", invoiceId: "keep-invoice", amountCents: 17500 }], allocatedCents: 17500,
      } } },
    },
  };
}
function mockBackend({ state = initialState(), team, onRead, onWrite } = {}) {
  const calls = { reads: [], writes: [], businessUrls: [] };
  const snapshot = () => {
    const matches = state.clients.filter((client) => String(client.id) === "c1");
    return {
      client: matches.length === 1 ? projection(matches[0]) : null,
      match_count: matches.length, clients_version: state.clientsVersion,
      billing_exists: state.billingExists, billing_version: state.billingVersion, ledger: clone(state.ledger),
    };
  };
  const apply = (body) => {
    assert.equal(body.p_expected_clients_version, state.clientsVersion);
    assert.equal(body.p_expected_billing_version, state.billingVersion);
    const client = state.clients.find((candidate) => String(candidate.id) === body.p_client_id);
    if (body.p_maintenance_billing) client.maintenanceBilling = clone(body.p_maintenance_billing);
    else delete client.maintenanceBilling;
    state.ledger = clone(body.p_ledger);
    state.billingExists = true;
    state.clientsVersion += 1;
    state.billingVersion += 1;
    return {
      applied: true, outcome: "applied", client: projection(client),
      current_versions: { sps_clients: state.clientsVersion, sps_maintenance_billing: state.billingVersion },
    };
  };
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "staff@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team || [{ email: "staff@example.com", role: "owner" }]) }]);
    calls.businessUrls.push(href);
    const body = JSON.parse(options.body || "{}");
    if (href.endsWith("/rpc/sps_client_maintenance_billing_snapshot")) {
      calls.reads.push(body);
      assert.deepEqual(body, { p_client_id: "c1" });
      const intercepted = await onRead?.({ state, calls, options, snapshot });
      return intercepted ?? response(snapshot());
    }
    if (href.endsWith("/rpc/sps_client_maintenance_billing_cas")) {
      calls.writes.push(body);
      assert.equal(body.p_client_id, "c1");
      assert.equal(Object.hasOwn(body, "clients"), false);
      assert.equal(Object.hasOwn(body, "p_clients"), false);
      const intercepted = await onWrite?.({ state, calls, body, options, apply });
      return intercepted ?? response([apply(body)]);
    }
    throw new Error(`Unexpected business request: ${href}`);
  };
  return { state, calls };
}
const stallUntilAbort = (options, onAbort = () => {}) => new Promise((_, reject) => {
  options.signal.addEventListener("abort", () => {
    onAbort();
    reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  }, { once: true });
});
async function invoke(policy = prepaid) {
  // Real request deadlines are unref'd; keep this isolated test request alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const res = mockResponse();
    await handler(request(policy), res);
    return res;
  } finally { clearInterval(keepAlive); }
}

test("maintenance billing requires invoice-create accounting access", () => {
  assert.equal(memberHasCapability({ role: "field", tabAccess: { invoices: "view" } }, "invoiceCreate"), false);
  assert.equal(memberHasCapability({ role: "custom", tabAccess: { invoices: "edit" }, fine: { invoiceCreate: false } }, "invoiceCreate"), false);
  assert.equal(memberHasCapability({ role: "custom", tabAccess: { invoices: "edit" }, fine: { invoiceCreate: true } }, "invoiceCreate"), true);
  assert.equal(memberHasCapability({ role: "owner", tabAccess: { invoices: "hidden" } }, "invoiceCreate"), true);
  assert.equal(config.maxDuration, 60);
});

test("unauthorized staff are rejected before billing RPCs are read or written", async () => {
  const { calls } = mockBackend({ team: [{ email: "staff@example.com", role: "field", tabAccess: { invoices: "view", clients: "edit" } }] });
  const res = await invoke();
  assert.equal(res.statusCode, 403);
  assert.equal(calls.businessUrls.length, 0);
});

test("an old invoice link round-trips while client history and other paid allocations stay intact", async () => {
  const { state, calls } = mockBackend({ team: [{ email: "staff@example.com", role: "custom", tabAccess: { invoices: "edit", clients: "edit" }, fine: { invoiceCreate: true } }] });
  const before = clone(state);
  const res = await invoke();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(state.clients[0].maintenanceBilling, prepaid);
  assert.deepEqual(state.clients[0].history, before.clients[0].history);
  assert.equal(state.clients[0].phone, before.clients[0].phone);
  assert.deepEqual(state.clients[1], before.clients[1]);
  assert.deepEqual(state.ledger.policies.c1, prepaid);
  assert.deepEqual(state.ledger.policies.c2, before.ledger.policies.c2);
  assert.deepEqual(state.ledger.allocations, before.ledger.allocations);
  assert.equal(res.body.clientProjection, true);
  assert.equal(Object.hasOwn(res.body.client, "history"), false, "the receipt is not a replacement profile");
  assert.deepEqual(res.body.versions, { sps_clients: 5, sps_maintenance_billing: 3 });
  const retry = await invoke();
  assert.equal(retry.body.alreadySaved, true);
  assert.deepEqual(retry.body.maintenanceBilling, prepaid);
  assert.equal(calls.writes.length, 1, "retry does not rewrite the large client row");
  assert.equal(calls.businessUrls.every((url) => url.includes("/rpc/sps_client_maintenance_billing_")), true);
});

test("a CAS retry re-reads the winning client version and policy removal preserves concurrent edits", async () => {
  const state = initialState();
  state.clients[0].maintenanceBilling = clone(prepaid);
  state.ledger.policies.c1 = clone(prepaid);
  const { calls } = mockBackend({ state, onWrite({ state, calls }) {
    if (calls.writes.length !== 1) return;
    state.clients[0].name = "Concurrent winner";
    state.clients[0].history.push({ id: "concurrent-visit" });
    state.clientsVersion += 1;
    return response([{ applied: false, outcome: "conflict", conflict_key: "sps_clients", current_versions: { sps_clients: state.clientsVersion } }]);
  } });
  const res = await invoke(null);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.writes.length, 2);
  assert.equal(calls.writes[1].p_expected_clients_version, 5);
  assert.equal(state.clients[0].name, "Concurrent winner");
  assert.equal(state.clients[0].history.length, 2);
  assert.equal(Object.hasOwn(state.clients[0], "maintenanceBilling"), false);
  assert.equal(Object.hasOwn(state.ledger.policies, "c1"), false);
  assert.equal(res.body.client.name, "Concurrent winner");
});

test("partial-month coverage is rejected before billing RPCs run", async () => {
  const { calls } = mockBackend();
  const res = await invoke({ version: 1, mode: "prepaid", coveredFrom: "2026-08-15", coveredThrough: "2026-09-14" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /first day of a month/i);
  assert.equal(calls.businessUrls.length, 0);
});

test("one stalled snapshot is aborted and retried before the single billing write", async () => {
  console.error = () => {};
  let aborted = false;
  const { calls } = mockBackend({ onRead({ calls, options }) {
    if (calls.reads.length === 1) return stallUntilAbort(options, () => { aborted = true; });
  } });
  const res = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(aborted, true);
  assert.equal(calls.reads.length, 2);
  assert.equal(calls.writes.length, 1);
});

test("persistent read timeouts stop after one retry with phase telemetry and no mutation", async () => {
  const logs = [];
  console.error = (...args) => logs.push(args);
  const { calls } = mockBackend({ onRead({ options }) { return stallUntilAbort(options); } });
  const res = await invoke();
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.code, "maintenance-billing-data-timeout");
  assert.equal(res.body.retryable, true);
  assert.equal(res.body.commitState, "not-started");
  assert.equal(calls.reads.length, 2);
  assert.equal(calls.writes.length, 0);
  const event = JSON.parse(logs.at(-1)[1]);
  assert.equal(event.phase, "read-baseline");
  assert.equal(event.operation, "sps_client_maintenance_billing_snapshot");
  assert.equal(event.timeoutMs, 250);
});

test("a committed write with a timed-out response is verified from both canonical copies", async () => {
  console.error = () => {};
  const { calls } = mockBackend({ onWrite({ body, apply, options }) {
    apply(body);
    return stallUntilAbort(options);
  } });
  const res = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.confirmedAfterUncertainWrite, true);
  assert.deepEqual(res.body.maintenanceBilling, prepaid);
  assert.equal(calls.writes.length, 1, "an uncertain write is verified, never automatically replayed");
  assert.equal(calls.reads.length, 2);
  assert.deepEqual(res.body.versions, { sps_clients: 5, sps_maintenance_billing: 3 });
});

test("an unconfirmed write preserves retry guidance without falsely claiming nothing changed", async () => {
  console.error = () => {};
  const { calls, state } = mockBackend({ onWrite() { throw new TypeError("fetch failed"); } });
  const res = await invoke();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "maintenance-billing-save-unconfirmed");
  assert.equal(res.body.commitState, "unconfirmed");
  assert.equal(res.body.retryable, true);
  assert.doesNotMatch(res.body.error, /nothing (was )?changed/i);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.reads.length, 2);
  assert.equal(state.clients[0].maintenanceBilling, undefined);
});

test("a client mirror alone is not enough to confirm a lost write receipt", async () => {
  console.error = () => {};
  const { calls } = mockBackend({ onWrite({ state }) {
    state.clients[0].maintenanceBilling = clone(prepaid);
    throw new TypeError("lost write response");
  } });
  const res = await invoke();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.commitState, "unconfirmed");
  assert.equal(calls.writes.length, 1);
});

test("standard billing removal is confirmed after a lost write response", async () => {
  console.error = () => {};
  const state = initialState();
  state.clients[0].maintenanceBilling = clone(prepaid);
  state.ledger.policies.c1 = clone(prepaid);
  const { calls } = mockBackend({ state, onWrite({ body, apply }) { apply(body); throw new TypeError("lost response"); } });
  const res = await invoke(null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.confirmedAfterUncertainWrite, true);
  assert.equal(res.body.maintenanceBilling, null);
  assert.equal(Object.hasOwn(res.body.client, "maintenanceBilling"), false);
  assert.equal(calls.writes.length, 1);
});

test("duplicate client IDs and malformed ledgers fail closed without mutation", async () => {
  console.error = () => {};
  let state = initialState();
  state.clients.push({ id: "c1", name: "Duplicate" });
  let backend = mockBackend({ state });
  let res = await invoke();
  assert.equal(res.statusCode, 409);
  assert.equal(backend.calls.writes.length, 0);
  state = initialState();
  state.ledger.allocations = [];
  backend = mockBackend({ state });
  res = await invoke();
  assert.equal(res.statusCode, 502);
  assert.equal(backend.calls.writes.length, 0);
  assert.equal(backend.calls.reads.length, 1);
});

test("a missing narrow RPC surfaces an unavailable service without a full-roster fallback", async () => {
  console.error = () => {};
  const { calls } = mockBackend({ onRead() { return response({ code: "PGRST202" }, false, 404); } });
  const res = await invoke();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "maintenance-billing-unavailable");
  assert.equal(calls.reads.length, 1);
  assert.equal(calls.writes.length, 0);
});
