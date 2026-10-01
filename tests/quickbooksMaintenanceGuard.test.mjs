import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { buildQuickBooksInvoicePayload } from "../quickbooksDraftSync.js";
import { fingerprintQuickBooksInvoiceContent } from "../api/quickbooks/invoice-revision.js";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.API_AUTH_ENFORCED = "true";
process.env.QB_API_BASE = "https://quickbooks.test";
const { default: createInvoice } = await import("../api/quickbooks/create-invoice.js");
const { default: updateInvoice } = await import("../api/quickbooks/update-invoice.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const client = { id: "client-a", qbId: "customer-a", name: "Maple Court", monthlyRate: "175", planFreq: "Monthly", history: [] };
const serviceLine = { id: "line-a", desc: "Monthly maintenance", kind: "service", qty: "1", unitPrice: "175", taxable: false, qbItemRef: { value: "item-1" } };
const sourceInvoice = { id: "paid-source", number: "INV-PAID", clientId: client.id, date: "10/01/2026", dueDate: "10/01/2026", status: "Paid", balance: 0, total: 175, lineItems: [serviceLine] };
const draft = () => ({ id: "draft-a", number: "INV-NEW", clientId: client.id, date: "10/01/2026", dueDate: "10/15/2026", status: "Draft", lineItems: [serviceLine] });
const ledger = () => ({ version: 2, policies: {}, allocations: { [client.id]: { "2026-10": { status: "paid", expectedCents: 17500, allocatedCents: 17500, sources: [{ kind: "invoice", invoiceId: sourceInvoice.id, amountCents: 17500 }] } } } });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const res = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
const request = invoice => ({ method: "POST", headers: { authorization: "Bearer demo-token" }, body: { invoice } });
const qbInvoice = (id = "qb-draft") => ({
  Id: id, SyncToken: "1", CustomerRef: { value: client.qbId }, DocNumber: "INV-NEW", TxnDate: "2026-10-01", DueDate: "2026-10-15",
  Line: [{ Id: "1", DetailType: "SalesItemLineDetail", Amount: 175, Description: "Monthly maintenance", SalesItemLineDetail: { ItemRef: { value: "item-1" }, Qty: 1, UnitPrice: 175, TaxCodeRef: { value: "NON" } } }],
});

function install({ clients = [client], invoices = [sourceInvoice], billing = ledger(), schedule = [], existing = qbInvoice(), stateFailure = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || "GET", body: options.body });
    if (href.endsWith("/auth/v1/user")) return response({ id: "owner", email: "owner@example.test" });
    if (href.includes("/rest/v1/app_state?")) {
      if (stateFailure) return response({ error: "unavailable" }, 503);
      return response(Object.entries({ sps_clients: clients, sps_invoices: invoices, sps_maintenance_billing: billing, sps_schedule: schedule })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ({ key, value: JSON.stringify(value), version: 1 })));
    }
    if (href.includes("/rest/v1/qb_tokens")) return response([{ id: "default", realm_id: "demo", access_token: "token", refresh_token: "refresh", expires_at: "2099-01-01T00:00:00Z" }]);
    if (href.includes("/customer/")) return response({ Customer: { Id: client.qbId } });
    if (href.includes("/invoice/") || href.includes("/invoice?")) return response({ Invoice: existing });
    throw new Error(`Unexpected fetch: ${href}`);
  };
  return calls;
}
const qbWrites = calls => calls.filter(call => call.href.startsWith("https://quickbooks.test") && call.method !== "GET");

test("create rejects a new covered maintenance charge before customer, item, or invoice writes", async () => {
  const calls = install();
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(draft(), client, {})), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(qbWrites(calls).length, 0);
  assert.equal(calls.some(call => call.href.startsWith("https://quickbooks.test")), false);
});

test("update checks payment coverage after revision validation and before resolving items or writing", async () => {
  const saved = { ...draft(), qbId: "qb-draft" };
  const existing = qbInvoice();
  const calls = install({ invoices: [sourceInvoice, saved], existing });
  const payload = { ...buildQuickBooksInvoicePayload(saved, client, {}), qbBaseContentFingerprint: fingerprintQuickBooksInvoiceContent(existing) };
  const result = res();
  await updateInvoice(request(payload), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(qbWrites(calls).length, 0);
});

test("server does not trust profile prepaid mirrors, while an authoritative policy blocks duplicates", async () => {
  const policy = { version: 1, mode: "prepaid", coveredFrom: "2026-10-01", coveredThrough: "2026-10-31", sourceInvoiceId: sourceInvoice.id };
  let calls = install({ clients: [{ ...client, maintenanceBilling: policy }], invoices: [], billing: { version: 2, policies: {}, allocations: {} } });
  let result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(draft(), client, {})), result);
  assert.equal(result.statusCode, 200);
  assert.equal(qbWrites(calls).length, 1);
  calls = install({ billing: { version: 1, policies: { [client.id]: policy } } });
  result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(draft(), client, {})), result);
  assert.equal(result.statusCode, 409);
  assert.equal(qbWrites(calls).length, 0);
});

test("canonical service month survives an older payload omitting source metadata", async () => {
  const saved = { ...draft(), source: "monthly-maintenance", autoPeriod: "2026-10", date: "12/01/2026", lineItems: [{ ...serviceLine, desc: "Routine work" }] };
  const payload = buildQuickBooksInvoicePayload(saved, client, {});
  delete payload.source;
  delete payload.autoPeriod;
  const calls = install({ invoices: [sourceInvoice, saved] });
  const result = res();
  await createInvoice(request(payload), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(qbWrites(calls).length, 0);
});

test("client ownership mismatches and ambiguous QuickBooks customers cannot select another client's coverage", async () => {
  const other = { ...client, id: "other-client", qbId: "other-qb" };
  for (const setup of [
    { clients: [client, other], payload: { clientId: other.id } },
    { clients: [client, { ...other, qbId: client.qbId }], payload: {} },
    { clients: [client], payload: { clientId: "missing" } },
  ]) {
    const calls = install(setup);
    const result = res();
    await createInvoice(request({ ...buildQuickBooksInvoicePayload(draft(), client, {}), ...setup.payload }), result);
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, "maintenance-client-unverified");
    assert.equal(qbWrites(calls).length, 0);
  }
});

test("unchanged canonical prepayment evidence can sync, but borrowing its identity or adding charges cannot", async () => {
  let calls = install();
  let result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(sourceInvoice, client, {})), result);
  assert.equal(result.statusCode, 200);
  assert.equal(qbWrites(calls).length, 1);
  calls = install();
  result = res();
  const changed = buildQuickBooksInvoicePayload({ ...sourceInvoice, lineItems: [{ ...serviceLine, unitPrice: "350" }] }, client, {});
  await createInvoice(request(changed), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(qbWrites(calls).length, 0);
  calls = install();
  result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload({ ...draft(), number: sourceInvoice.number, qbId: "invented" }, client, {})), result);
  assert.equal(result.statusCode, 409);
  assert.equal(qbWrites(calls).length, 0);
});

test("linked source updates remain allowed when unchanged, and create cannot duplicate its existing QB link", async () => {
  const source = { ...sourceInvoice, qbId: "qb-source" };
  const existing = qbInvoice(source.qbId);
  let calls = install({ invoices: [source], existing });
  let result = res();
  await updateInvoice(request({ ...buildQuickBooksInvoicePayload(source, client, {}), qbBaseContentFingerprint: fingerprintQuickBooksInvoiceContent(existing) }), result);
  assert.equal(result.statusCode, 200);
  assert.equal(qbWrites(calls).length, 1);
  calls = install({ invoices: [source] });
  result = res();
  await createInvoice(request({ ...buildQuickBooksInvoicePayload(source, client, {}), qbCreateRequestKey: "new-copy" }), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-invoice-already-linked");
  assert.equal(qbWrites(calls).length, 0);
});

test("unrelated repair and purchased extras remain billable for a prepaid client", async () => {
  for (const line of [{ ...serviceLine, desc: "Pump repair" }, { ...serviceLine, desc: "Maintenance kit", kind: "product" }]) {
    const calls = install();
    const result = res();
    await createInvoice(request(buildQuickBooksInvoicePayload({ ...draft(), lineItems: [line] }, client, {})), result);
    assert.equal(result.statusCode, 200);
    assert.equal(qbWrites(calls).length, 1);
  }
});

test("coverage outages and invalid ledgers stop maintenance writes", async () => {
  for (const setup of [{ stateFailure: true }, { billing: { version: 99 } }]) {
    const calls = install(setup);
    const result = res();
    await createInvoice(request(buildQuickBooksInvoicePayload(draft(), client, {})), result);
    assert.equal(result.statusCode, 503);
    assert.equal(qbWrites(calls).length, 0);
  }
});

test("explicit repair-only charges do not depend on coverage availability, while generic service still requires verification", async () => {
  for (const description of ["Pump repair", "Installation labor", "Equipment replacement"]) {
    const calls = install({ stateFailure: true });
    const result = res();
    await createInvoice(request(buildQuickBooksInvoicePayload({ ...draft(), lineItems: [{ ...serviceLine, desc: description }] }, client, {})), result);
    assert.equal(result.statusCode, 200, description);
    assert.equal(qbWrites(calls).length, 1);
    assert.equal(calls.some(call => call.href.includes("/rest/v1/app_state?")), false);
  }
  for (const line of [{ ...serviceLine, desc: "Services" }, { ...serviceLine, desc: "Services", sourceStopId: "stop-a" }, { ...serviceLine, desc: "Services", billingMode: "one-off" }]) {
    const calls = install({ stateFailure: true });
    const result = res();
    await createInvoice(request(buildQuickBooksInvoicePayload({ ...draft(), lineItems: [line] }, client, {})), result);
    assert.equal(result.statusCode, 503);
    assert.equal(qbWrites(calls).length, 0);
  }
});

test("shared payload preserves client and completed-service identity for authoritative checks", () => {
  const payload = buildQuickBooksInvoicePayload({ ...draft(), autoPeriod: "2026-10", sourceStopIds: ["stop-a"], lineItems: [{ ...serviceLine, sourceCompletionReceiptId: "receipt-a" }] }, client, {});
  assert.equal(payload.clientId, client.id);
  assert.equal(payload.autoPeriod, "2026-10");
  assert.deepEqual(payload.sourceStopIds, ["stop-a"]);
  assert.equal(payload.lineItems[0].sourceCompletionReceiptId, "receipt-a");
});

test("a saved unsynced manual draft can deliberately select another client before its first QB create", async () => {
  const selected = { ...client, id: "client-b", qbId: "customer-b", name: "Birch Court" };
  const saved = { ...draft(), qbCustomerId: client.qbId };
  const calls = install({ clients: [client, selected], invoices: [saved], billing: { version: 2, policies: {}, allocations: {} } });
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload({ ...saved, clientId: selected.id }, selected, {})), result);
  assert.equal(result.statusCode, 200);
  const write = qbWrites(calls).find(call => call.href.includes("/invoice?"));
  assert.equal(JSON.parse(write.body).CustomerRef.value, selected.qbId);
});

test("draft reassignment still checks the newly selected client's prepaid coverage", async () => {
  const selected = { ...client, id: "client-b", qbId: "customer-b", name: "Birch Court" };
  const saved = draft();
  const prepaid = { ...sourceInvoice, clientId: selected.id };
  const billing = { version: 2, policies: {}, allocations: { [selected.id]: ledger().allocations[client.id] } };
  const calls = install({ clients: [client, selected], invoices: [saved, prepaid], billing });
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload({ ...saved, clientId: selected.id }, selected, {})), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(qbWrites(calls).length, 0);
});

test("client reassignment cannot move imported work, estimate links, payment evidence, sent drafts, or QB outcomes", async () => {
  const selected = { ...client, id: "client-b", qbId: "customer-b", name: "Birch Court" };
  const protectedChanges = [
    { sourceStopIds: ["stop-a"] }, { sourceCompletionReceiptIds: ["receipt-a"] }, { sourceEstimateId: "estimate-a" },
    { lineItems: [{ ...serviceLine, sourceStopId: "stop-a" }] }, { payments: [{ amount: 10 }] }, { balance: 0 },
    { sentAt: "2026-10-01T12:00:00Z" }, { qbCreateOutcomeUnknown: true }, { qbId: "qb-existing" },
  ];
  for (const change of protectedChanges) {
    const saved = { ...draft(), ...change };
    const calls = install({ clients: [client, selected], invoices: [saved], billing: { version: 2, policies: {}, allocations: {} } });
    const result = res();
    await createInvoice(request(buildQuickBooksInvoicePayload({ ...saved, clientId: selected.id }, selected, {})), result);
    assert.equal(result.statusCode, 409, JSON.stringify(change));
    assert.equal(result.body.code, "maintenance-client-unverified");
    assert.equal(qbWrites(calls).length, 0);
  }
});
