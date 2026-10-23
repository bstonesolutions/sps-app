import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
process.env.SUPABASE_URL = "https://payment-supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.API_AUTH_ENFORCED = "true";
process.env.QB_API_BASE = "https://payment-quickbooks.test";
const { default: recordPayment } = await import("../api/quickbooks/record-payment.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
const res = () => ({ statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }, end() { return this; } });
const req = () => ({ method: "POST", headers: { authorization: "Bearer owner-token" },
  body: { qbId: "qb-1", spsInvoiceId: "local-1", amount: 100, method: "Other" } });

function fixture({ role = "owner", paymentFailure = null, canonicalFailure = false, unreadablePayment = false, failedReread = false } = {}) {
  let paid = false, version = 4;
  let invoices = [{ id: "local-1", qbId: "qb-1", qbCustomerId: "customer-1", clientId: "c1", total: 100, balance: 100, notes: "Keep this note", lineItems: [] }];
  const calls = [];
  const invoice = () => ({ Id: "qb-1", CustomerRef: { value: "customer-1", name: "Customer" }, DocNumber: "2101",
    TxnDate: "2026-10-20", DueDate: "2026-11-04", SyncToken: paid ? "2" : "1", TotalAmt: 100, Balance: paid ? 0 : 100,
    Line: [{ Id: "1", DetailType: "SalesItemLineDetail", Amount: 100, Description: "Repair visit",
      SalesItemLineDetail: { ItemRef: { value: "8", name: "Services" }, Qty: 1, UnitPrice: 100 } }] });
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url); calls.push({ href, method: options.method || "GET", body: options.body });
    if (href.endsWith("/auth/v1/user")) return response({ id: "owner-1", email: "owner@example.test" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ email: "owner@example.test", role }]) }]);
    if (href.includes("/qb_tokens?")) return response([{ realm_id: "realm", access_token: "access", expires_at: "2099-01-01T00:00:00Z" }]);
    if (href.includes("/app_state?") && href.includes("key=eq.sps_clients")) return response([{ key: "sps_clients", version: 1, value: JSON.stringify([{ id: "c1", qbId: "customer-1", name: "Customer" }]) }]);
    if (href.includes("/app_state?") && href.includes("key=eq.sps_invoices")) return response([{ key: "sps_invoices", version, value: JSON.stringify(invoices) }]);
    if (href.endsWith("/rpc/sps_invoice_canonical_cas")) {
      if (canonicalFailure) return response({}, 503);
      const body = JSON.parse(options.body);
      assert.equal(body.p_action, "quickbooks-payment"); assert.equal(body.p_actor_id, "owner-1");
      assert.equal(body.p_expected_version, version);
      invoices = JSON.parse(body.p_value); version++;
      return response([{ applied: true, outcome: "applied", current_version: version, value: invoices }]);
    }
    if (href.includes("/invoice/qb-1?")) {
      if (paid && failedReread) throw new Error("reread offline");
      return response({ Invoice: invoice() });
    }
    if (href.includes("/payment?") && options.method === "POST") {
      if (paymentFailure === "network") throw new Error("socket closed after upload");
      if (paymentFailure) return response({ Fault: { Error: [{ Message: "QB fault" }] } }, paymentFailure);
      paid = true;
      if (unreadablePayment) return { ok: true, status: 200, json: async () => { throw new Error("invalid JSON"); } };
      return response({ Payment: { Id: "payment-1" } });
    }
    throw new Error(`Unexpected request ${href}`);
  };
  return { calls, get invoices() { return invoices; } };
}

test("confirmed payment persists its actual remaining balance and returns an actor-bound full receipt", async () => {
  const f = fixture(); const out = res(); await recordPayment(req(), out);
  assert.equal(out.statusCode, 200); assert.equal(out.body.success, true); assert.equal(out.body.paymentId, "payment-1");
  assert.equal(out.body.invoiceRefresh.actorId, "owner-1"); assert.equal(out.body.invoiceRefresh.afterVersion, 5);
  assert.equal(f.invoices[0].balance, 0); assert.equal(f.invoices[0].status, "Paid"); assert.equal(f.invoices[0].notes, "Keep this note");
  assert.equal(f.calls.filter(call => call.href.includes("/payment?") && call.method === "POST").length, 1);
});

test("a successful payment remains success when SPS persistence or the invoice reread fails", async () => {
  for (const options of [{ canonicalFailure: true }, { failedReread: true }]) {
    const f = fixture(options); const out = res(); await recordPayment(req(), out);
    assert.equal(out.statusCode, 200); assert.equal(out.body.success, true); assert.equal(out.body.appSyncPending, true);
    assert.match(out.body.warning, /do not create or record it again/);
    assert.equal(f.calls.filter(call => call.href.includes("/payment?") && call.method === "POST").length, 1);
  }
});

test("a successful HTTP payment with unreadable response still rereads its invoice and never repeats the write", async () => {
  const f = fixture({ unreadablePayment: true }); const out = res(); await recordPayment(req(), out);
  assert.equal(out.statusCode, 200); assert.equal(out.body.success, true); assert.equal(out.body.paymentId, null);
  assert.equal(out.body.invoiceRefresh.invoices[0].balance, 0);
  assert.equal(f.calls.filter(call => call.href.includes("/payment?") && call.method === "POST").length, 1);
});

test("ambiguous payment outcomes instruct a QB check without declaring a rejection or success", async () => {
  for (const paymentFailure of ["network", 503, 408]) {
    const f = fixture({ paymentFailure }); const out = res(); await recordPayment(req(), out);
    assert.equal(out.statusCode, 502); assert.equal(out.body.paymentOutcomeUnknown, true);
    assert.equal(out.body.success, undefined); assert.match(out.body.error, /Check QuickBooks before retrying/);
    assert.equal(f.calls.some(call => call.href.includes("sps_invoice_canonical_cas")), false);
  }
});

test("known rejection and unauthorized staff do not produce a canonical payment receipt", async () => {
  let f = fixture({ paymentFailure: 400 }); let out = res(); await recordPayment(req(), out);
  assert.equal(out.statusCode, 422); assert.equal(out.body.paymentOutcomeUnknown, undefined);
  assert.equal(f.calls.some(call => call.href.includes("sps_invoice_canonical_cas")), false);
  f = fixture({ role: "viewer" }); out = res(); await recordPayment(req(), out);
  assert.equal(out.statusCode, 403); assert.equal(f.calls.some(call => call.href.startsWith("https://payment-quickbooks.test")), false);
});
