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
const serviceLine = { id: "line-a", desc: "Monthly maintenance - October 2026", kind: "service", qty: "1", unitPrice: "175", taxable: false, qbItemRef: { value: "item-1" } };
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

const payerClient = () => ({ ...client, address: "21 Orchard Road", email: "billing@example.test", phone: "(555) 222-1000" });
const payerAlias = () => ({ ...payerClient(), id: "company-alias", name: "Maple Property Company", history: [] });
const noCoverage = () => ({ version: 2, policies: {}, allocations: {} });

for (const [operation, handler] of [["create", createInvoice], ["update", updateInvoice]]) {
  test(`${operation} keeps a canonical SPS owner when its company alias shares the same QB payer and contacts`, async () => {
    const owner = payerClient();
    const saved = { ...draft(), source: "monthly-maintenance", autoPeriod: "2026-10",
      ...(operation === "update" ? { qbId: "qb-draft" } : {}) };
    const existing = qbInvoice();
    const calls = install({ clients: [payerAlias(), owner], invoices: [saved], billing: noCoverage(), existing });
    const payload = buildQuickBooksInvoicePayload(saved, owner, {});
    if (operation === "update") payload.qbBaseContentFingerprint = fingerprintQuickBooksInvoiceContent(existing);
    const result = res();
    await handler(request(payload), result);
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    const writes = qbWrites(calls);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].body).CustomerRef.value, owner.qbId);
  });
}

test("a payer alias still checks the canonical owner's prepaid coverage", async () => {
  const owner = payerClient();
  const saved = { ...draft(), source: "monthly-maintenance" };
  const calls = install({ clients: [payerAlias(), owner], invoices: [saved, sourceInvoice] });
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(saved, owner, {})), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(qbWrites(calls).length, 0);
});

test("shared QB payer contacts never replace missing, duplicate, reassigned, or contradictory ownership", async () => {
  const owner = payerClient();
  const alias = payerAlias();
  const saved = { ...draft(), source: "monthly-maintenance", autoPeriod: "2026-10" };
  const payload = buildQuickBooksInvoicePayload(saved, owner, {});
  const cases = [
    { invoices: [], label: "no canonical invoice" },
    { invoices: [saved, { ...saved }], label: "duplicate canonical invoice" },
    { clients: [owner, { ...owner }, alias], label: "duplicate canonical client" },
    { payload: { clientId: alias.id }, label: "different requested client" },
    { payload: { qbCustomerId: "wrong-qb-customer" }, label: "different requested payer" },
    { invoices: [{ ...saved, qbCustomerId: "wrong-qb-customer" }], label: "different saved payer" },
    { clients: [{ ...owner, qbId: "wrong-qb-customer" }, alias], label: "payer belongs only to alias" },
    { invoices: [{ ...saved, source: "manual", clientId: alias.id }], label: "manual draft reassignment" },
    { clients: [owner, { ...alias, address: "99 Other Road" }], label: "different address" },
    { clients: [owner, { ...alias, email: "other@example.test" }], label: "different email" },
    { clients: [owner, { ...alias, phone: "5552229999" }], label: "different phone" },
    { clients: [owner, { ...alias, phone: "" }], label: "missing contact evidence" },
  ];
  for (const item of cases) {
    const calls = install({ clients: [owner, alias], invoices: [saved], billing: noCoverage(), ...item });
    const result = res();
    await createInvoice(request({ ...payload, ...item.payload }), result);
    assert.equal(result.statusCode, 409, `${item.label}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, "maintenance-client-unverified", item.label);
    assert.equal(qbWrites(calls).length, 0, item.label);
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
  const saved = { ...draft(), qbCustomerId: client.qbId, serviceMonth: "2026-10" };
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

test("outgoing maintenance missing a service month is held even when its issue date is valid", async () => {
  const calls = install({ invoices: [], billing: { version: 2, policies: {}, allocations: {} } });
  const invoice = { ...draft(), date: "12/01/2026", lineItems: [{ ...serviceLine, desc: "Monthly maintenance" }] };
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(invoice, client, {})), result);
  assert.equal(result.statusCode, 422);
  assert.equal(result.body.code, "maintenance-service-month-missing");
  assert.equal(qbWrites(calls).length, 0);
});

test("outgoing maintenance checks its described month instead of a later issue date", async () => {
  const calls = install();
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload({ ...draft(), date: "12/01/2026" }, client, {})), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(qbWrites(calls).length, 0);
});

test("saved visit provenance detects a conflicting outgoing month before any QuickBooks writes", async () => {
  const linkedClient = { ...client, history: [{ sid: "october-stop", type: "Monthly Service", date: "10/15/2026" }] };
  const saved = { ...draft(), sourceStopId: "october-stop", date: "12/01/2026" };
  const calls = install({ clients: [linkedClient], invoices: [sourceInvoice, saved] });
  const edited = { ...saved, lineItems: [{ ...serviceLine, desc: "Monthly maintenance - December 2026" }] };
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(edited, linkedClient, {})), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-service-month-conflict");
  assert.equal(qbWrites(calls).length, 0);
});

test("a manual draft can correct its selected service month without changing its client", async () => {
  const saved = { ...draft(), serviceMonth: "2026-10", lineItems: [{ ...serviceLine, desc: "Monthly maintenance" }] };
  const calls = install({ invoices: [saved], billing: { version: 2, policies: {}, allocations: {} } });
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload({ ...saved, serviceMonth: "2026-11" }, client, {})), result);
  assert.equal(result.statusCode, 200);
  const write = qbWrites(calls).find(call => call.href.includes("/invoice?"));
  assert.match(JSON.parse(write.body).Line[0].Description, /November 2026/);
});

for (const [operation, handler] of [["create", createInvoice], ["update", updateInvoice]]) {
  test(`${operation} preserves the unchanged prepaid-source exemption for an unformatted valid payload`, async () => {
    const saved = { ...sourceInvoice, serviceMonth: "2026-10", ...(operation === "update" ? { qbId: "qb-draft" } : {}),
      lineItems: [{ ...serviceLine, desc: "Monthly maintenance" }],
    };
    const existing = qbInvoice();
    const calls = install({ invoices: [saved], existing });
    const payload = buildQuickBooksInvoicePayload(saved, client, {});
    payload.lineItems[0].description = "Monthly maintenance";
    if (operation === "update") payload.qbBaseContentFingerprint = fingerprintQuickBooksInvoiceContent(existing);
    const result = res();
    await handler(request(payload), result);
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    const writes = qbWrites(calls);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].body).Line[0].Description, "Monthly maintenance - October 2026");
  });

  for (const evidence of ["line date", "completed visit", "legacy monthly period"]) {
    test(`${operation} checks the transmitted month against canonical ${evidence} for an unformatted payload`, async () => {
      const linkedClient = { ...client, history: [{ sid: "october-stop", type: "Monthly Service", date: "10/15/2026" }] };
      const saved = { ...draft(), ...(operation === "update" ? { qbId: "qb-draft" } : {}),
        ...(evidence === "completed visit" ? { sourceStopId: "october-stop" } : {}),
        ...(evidence === "legacy monthly period" ? { source: "monthly-maintenance", autoPeriod: "2026-10" } : {}),
        lineItems: [{ ...serviceLine, desc: "Monthly maintenance", ...(evidence === "line date" ? { serviceDate: "2026-10-15" } : {}) }],
      };
      const existing = qbInvoice();
      const calls = install({ clients: [linkedClient], invoices: [saved], billing: { version: 2, policies: {}, allocations: {} }, existing });
      const payload = buildQuickBooksInvoicePayload(saved, linkedClient, {});
      delete payload.autoPeriod;
      payload.serviceMonth = "2026-11";
      payload.lineItems[0].description = "Monthly maintenance";
      delete payload.lineItems[0].serviceDate;
      if (operation === "update") payload.qbBaseContentFingerprint = fingerprintQuickBooksInvoiceContent(existing);
      const result = res();
      await handler(request(payload), result);
      assert.equal(result.statusCode, 409, JSON.stringify(result.body));
      assert.equal(result.body.code, "maintenance-service-month-conflict");
      assert.equal(qbWrites(calls).length, 0, "coverage must inspect the same month that QuickBooks would receive");
    });
  }

  for (const evidence of ["saved marker", "completed visit"]) {
    test(`${operation} holds undated generic Services identified as maintenance by ${evidence}`, async () => {
      const linkedClient = { ...client, history: [{ sid: "october-stop", type: "Monthly Service", date: "10/15/2026" }] };
      const saved = { ...draft(), ...(operation === "update" ? { qbId: "qb-draft" } : {}),
        ...(evidence === "completed visit" ? { sourceStopId: "october-stop" } : {}),
        lineItems: [{ ...serviceLine, desc: "Services", ...(evidence === "saved marker" ? { maintenanceService: true, serviceDate: "2026-10-15" } : {}) }],
      };
      const existing = qbInvoice();
      const calls = install({ clients: [linkedClient], invoices: [saved], billing: { version: 2, policies: {}, allocations: {} }, existing });
      const payload = buildQuickBooksInvoicePayload(saved, linkedClient, {});
      payload.lineItems[0].description = "Services";
      delete payload.lineItems[0].maintenanceService;
      delete payload.lineItems[0].serviceDate;
      if (operation === "update") payload.qbBaseContentFingerprint = fingerprintQuickBooksInvoiceContent(existing);
      const result = res();
      await handler(request(payload), result);
      assert.equal(result.statusCode, 409, JSON.stringify(result.body));
      assert.equal(result.body.code, "maintenance-service-month-missing");
      assert.equal(qbWrites(calls).length, 0, "known maintenance cannot reach QuickBooks without its performed month");
    });
  }
}

const manualBilling = (decision = 'unpaid') => ({ version: 2, policies: {}, allocations: { [client.id]: {
  '2026-10': { status: decision === 'paid' ? 'paid' : 'due',
    sources: [{ kind: 'manual', recordId: 'manual-client-a-2026-10', decision }],
    expectedCents: 17500, allocatedCents: decision === 'paid' ? 17500 : 0,
    updatedAt: '2026-10-05T12:00:00Z', updatedBy: 'owner@example.test', note: 'Owner checked payment record' },
} } });

test('owner unpaid allows create before matching without making paid owner months billable', async () => {
  const uncertain = { ...sourceInvoice, qbId: 'unresolved', status: 'Partial', balance: 25,
    lineItems: [{ ...serviceLine, desc: 'Maintenance prepayment' }] };
  let calls = install({ invoices: [uncertain], billing: manualBilling() });
  let result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(draft(), client, {})), result);
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(qbWrites(calls).length, 1);
  calls = install({ invoices: [], billing: manualBilling('paid') });
  result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(draft(), client, {})), result);
  assert.equal(result.body.code, 'maintenance-already-covered');
  assert.equal(qbWrites(calls).length, 0);
});

for (const [operation, handler] of [['create', createInvoice], ['update', updateInvoice]]) {
  test(`${operation} fills an unchanged unpaid source's service month from its explicit match`, async () => {
    const description = operation === 'create' ? 'Services' : 'Monthly maintenance';
    const saved = { ...draft(), status: 'Sent', balance: 175, total: 175, date: '12/01/2026',
      ...(operation === 'update' ? { qbId: 'qb-draft' } : {}),
      lineItems: [{ ...serviceLine, desc: description }] };
    const billing = { version: 2, policies: {}, allocations: { [client.id]: { '2026-10': {
      status: 'due', expectedCents: 17500, allocatedCents: 17500,
      sources: [{ kind: 'invoice', invoiceId: saved.id, amountCents: 17500 }],
    } } } };
    const existing = qbInvoice();
    const calls = install({ invoices: [saved], billing, existing });
    const payload = buildQuickBooksInvoicePayload(saved, client, {});
    if (operation === 'update') payload.qbBaseContentFingerprint = fingerprintQuickBooksInvoiceContent(existing);
    const result = res();
    await handler(request(payload), result);
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    const writes = qbWrites(calls);
    assert.equal(writes.length, 1);
    const written = JSON.parse(writes[0].body);
    assert.equal(written.Line[0].Description, `${description} - October 2026`);
    assert.equal(written.TxnDate, '2026-12-01');
  });
}

test('a matched unpaid source exemption never approves a changed amount or contradictory month', async () => {
  const saved = { ...draft(), status: 'Sent', balance: 175, total: 175 };
  const billing = { version: 2, policies: {}, allocations: { [client.id]: { '2026-10': {
    status: 'due', expectedCents: 17500, allocatedCents: 17500,
    sources: [{ kind: 'invoice', invoiceId: saved.id, amountCents: 17500 }],
  } } } };
  for (const changes of [{ unitPrice: '350' }, { serviceMonth: '2026-11' }, { desc: 'Monthly maintenance - November 2026' }]) {
    const calls = install({ invoices: [saved], billing });
    const result = res();
    await createInvoice(request(buildQuickBooksInvoicePayload({ ...saved,
      lineItems: [{ ...serviceLine, ...changes }] }, client, {})), result);
    assert.notEqual(result.statusCode, 200, JSON.stringify({ changes, response: result.body }));
    assert.equal(qbWrites(calls).length, 0);
  }
});
