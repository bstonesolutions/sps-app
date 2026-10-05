import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { fingerprintQuickBooksInvoiceContent } from "../api/quickbooks/invoice-revision.js";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.API_AUTH_ENFORCED = "true";
process.env.QB_API_BASE = "https://quickbooks.test";
const { default: handler } = await import("../api/quickbooks/delete-invoice.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const result = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
const canonical = () => ({ id: "invoice-1", qbId: "qb-1", qbContentFingerprint: fingerprintQuickBooksInvoiceContent(remote()), qbCustomerId: "customer-1", clientId: "client-1", number: "INV-1", status: "Sent", total: 100, balance: 100, lineItems: [{ desc: "Pump repair", qty: 1, unitPrice: 100 }] });
const remote = () => ({ Id: "qb-1", SyncToken: "4", CustomerRef: { value: "customer-1" }, DocNumber: "INV-1", TotalAmt: 100, Balance: 100, Line: [{ Id: "1", DetailType: "SalesItemLineDetail", Amount: 100, Description: "Pump repair", SalesItemLineDetail: { Qty: 1, UnitPrice: 100, ItemRef: { value: "service-1" } } }] });
const request = (invoice, extra = {}) => ({ method: "POST", headers: { authorization: "Bearer owner-token" }, body: { qb_id: "qb-1", reviewed_invoice: invoice, ...extra } });

function install({ invoice = canonical(), existing = remote(), team = [{ email: "owner@example.test", role: "owner" }], ledger = { version: 2, policies: {}, allocations: {} }, estimates = [], readStatus = 200, readBody, deleteStatus = 200, deleteBody = { Invoice: { Id: "qb-1", status: "Deleted" } }, throwDelete = false, mutateAfterRead = false } = {}) {
  const calls = [];
  let version = 1;
  const state = { sps_invoices: [invoice], sps_estimates: estimates, sps_schedule: [], sps_maintenance_billing: ledger, sps_clients: [{ id: "client-1", qbId: "customer-1" }] };
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || "GET", body: options.body });
    if (href.endsWith("/auth/v1/user")) return response({ id: "owner", email: "owner@example.test" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) return response(Object.entries(state).map(([key, value]) => ({ key, value: JSON.stringify(value), version })));
    if (href.includes("/rest/v1/qb_tokens")) return response([{ id: "default", realm_id: "realm-1", access_token: "access", refresh_token: "refresh", expires_at: "2099-01-01T00:00:00Z" }]);
    if (href.includes("/invoice/qb-1?")) {
      if (mutateAfterRead) version += 1;
      return response(readBody || { Invoice: existing }, readStatus);
    }
    if (href.includes("operation=delete")) {
      if (throwDelete) throw new Error("Connection closed after request");
      return response(deleteBody, deleteStatus);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  return calls;
}
const writes = (calls) => calls.filter((call) => call.href.includes("operation=delete"));

test("reviewed unpaid invoices delete with verified content and the current SyncToken", async () => {
  const invoice = canonical();
  const calls = install({ invoice });
  const res = result();
  await handler(request(invoice), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(writes(calls).length, 1);
  assert.deepEqual(JSON.parse(writes(calls)[0].body), { Id: "qb-1", SyncToken: "4" });
});

test("legacy invoices without a content fingerprint require refresh even when remote totals still match", async () => {
  const invoice = canonical();
  delete invoice.qbContentFingerprint;
  for (const existing of [remote(), { ...remote(), Line: [{ ...remote().Line[0], Description: "Replacement work changed remotely" }] }]) {
    const calls = install({ invoice, existing });
    const res = result();
    await handler(request(invoice), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "quickbooks_revision_missing");
    assert.equal(res.body.reviewRequired, true);
    assert.equal(writes(calls).length, 0, "matching customer and total alone cannot authorize deletion of unseen content");
  }
});

test("an already-deleted legacy invoice can finish cleanup without a saved content fingerprint", async () => {
  const invoice = canonical();
  delete invoice.qbContentFingerprint;
  const calls = install({ invoice, readStatus: 404 });
  const res = result();
  await handler(request(invoice), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alreadyGone, true);
  assert.equal(writes(calls).length, 0);
});

test("deletion requires invoiceDelete permission rather than merely a signed-in account", async () => {
  const calls = install({ team: [{ email: "owner@example.test", role: "custom", tabAccess: { invoices: "view" }, fine: { invoiceDelete: true } }] });
  const res = result();
  await handler(request(canonical()), res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.some((call) => call.href.startsWith("https://quickbooks.test")), false);
});

test("stale review and protected paid coverage stop deletion before any QuickBooks call", async () => {
  for (const setup of [
    { invoice: { ...canonical(), total: 200 } },
    { ledger: { version: 2, policies: {}, allocations: { "client-1": { "2026-10": { status: "paid", sources: [{ kind: "invoice", invoiceId: "invoice-1" }] } } } } },
  ]) {
    const calls = install(setup);
    const res = result();
    await handler(request(canonical()), res);
    assert.equal(res.statusCode, 409);
    assert.equal(calls.some((call) => call.href.startsWith("https://quickbooks.test")), false);
  }
});

test("job references require explicit unlink consent while the endpoint leaves jobs intact", async () => {
  const invoice = canonical();
  const estimates = [{ id: "estimate-1", linkedInvoiceId: invoice.id }];
  for (const unlinkJobs of [false, true]) {
    const calls = install({ invoice, estimates });
    const res = result();
    await handler(request(invoice, { unlinkJobs }), res);
    assert.equal(res.statusCode, unlinkJobs ? 200 : 409);
    assert.equal(writes(calls).length, unlinkJobs ? 1 : 0);
    assert.equal(estimates[0].linkedInvoiceId, invoice.id, "SPS unlinking belongs to the later atomic local transaction");
  }
});

test("an unpaid maintenance match can be explicitly unlinked for deletion without removing payment evidence", async () => {
  const ledger = { version: 2, policies: {}, allocations: { "client-1": { "2026-10": { status: "due", sources: [{ kind: "invoice", invoiceId: "invoice-1" }] } } } };
  for (const unlinkJobs of [false, true]) {
    const calls = install({ ledger });
    const res = result();
    await handler(request(canonical(), { unlinkJobs }), res);
    assert.equal(res.statusCode, unlinkJobs ? 200 : 409);
    assert.equal(writes(calls).length, unlinkJobs ? 1 : 0);
    assert.equal(ledger.allocations["client-1"]["2026-10"].sources[0].invoiceId, "invoice-1", "the endpoint does not mutate SPS accounting state");
  }
});

test("fresh QuickBooks payments, credits, deposits, and unknown balances protect the invoice", async () => {
  for (const change of [{ Balance: 0 }, { Balance: 50 }, { Balance: undefined }, { Deposit: 10 }, { LinkedTxn: [{ TxnType: "Payment", TxnId: "payment-1" }] }]) {
    const calls = install({ existing: { ...remote(), ...change } });
    const res = result();
    await handler(request(canonical()), res);
    assert.equal(res.statusCode, 409, JSON.stringify(change));
    assert.equal(res.body.code, "quickbooks_payment_protected");
    assert.equal(writes(calls).length, 0);
  }
});

test("fresh QuickBooks customer, amount, number, or saved-content changes require review", async () => {
  for (const change of [{ CustomerRef: { value: "other-customer" } }, { TotalAmt: 200, Balance: 200 }, { DocNumber: "OTHER" }, { Line: [] }]) {
    const invoice = { ...canonical(), qbContentFingerprint: fingerprintQuickBooksInvoiceContent(remote()) };
    const calls = install({ invoice, existing: { ...remote(), ...change } });
    const res = result();
    await handler(request(invoice), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "quickbooks_invoice_changed");
    assert.equal(writes(calls).length, 0);
  }
});

test("changed shared accounting versions stop deletion after the QuickBooks read", async () => {
  const calls = install({ mutateAfterRead: true });
  const res = result();
  await handler(request(canonical()), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "invoice_records_changed");
  assert.equal(writes(calls).length, 0);
});

test("precise missing-invoice responses finish a prior deletion without another write", async () => {
  for (const setup of [{ readStatus: 404 }, { readStatus: 400, readBody: { Fault: { Error: [{ code: "610", Message: "Object Not Found" }] } } }]) {
    const calls = install(setup);
    const res = result();
    await handler(request(canonical()), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.alreadyGone, true);
    assert.equal(writes(calls).length, 0);
  }
});

test("QuickBooks rejection explains the failure without reporting deletion success", async () => {
  const calls = install({ deleteStatus: 400, deleteBody: { Fault: { Error: [{ code: "5010", Message: "Stale Object Error", Detail: "The invoice changed." }] } } });
  const res = result();
  await handler(request(canonical()), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /Stale Object Error.*invoice changed/);
  assert.equal(writes(calls).length, 1);
});

test("lost or malformed delete receipts remain unknown and never permit optimistic local removal", async () => {
  for (const setup of [{ throwDelete: true }, { deleteBody: {} }, { deleteBody: { Invoice: { Id: "other", status: "Deleted" } } }]) {
    const calls = install(setup);
    const res = result();
    await handler(request(canonical()), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
    assert.equal(res.body.outcomeUnknown, true);
    assert.equal(writes(calls).length, 1);
  }
});
