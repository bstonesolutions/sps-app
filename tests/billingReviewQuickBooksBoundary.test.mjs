import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
process.env.QB_API_BASE = "https://quickbooks.test";
process.env.API_AUTH_ENFORCED = "true";
const { default: createInvoice } = await import("../api/quickbooks/create-invoice.js");
const { readQuickBooksInvoiceNumberInventory } = await import("../api/_billing-review-numbering.js");
const { BILLING_REVIEW_CREATE_CONTEXT } = await import("../api/_billing-review-context.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
const res = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
const request = invoice => ({ method: "POST", headers: { authorization: "Bearer owner-token" }, body: { invoice } });
const tokens = [{ realm_id: "realm", access_token: "token", expires_at: "2099-01-01T00:00:00Z" }];

test("public create refuses canonical review identity even with spoofed trusted context in JSON", async () => {
  const seen = [];
  globalThis.fetch = async url => {
    const href = String(url); seen.push(href);
    if (href.endsWith("/auth/v1/user")) return response({ id: "owner", email: "owner@example.test" });
    if (href.includes("/app_state?")) return response([{ key: "sps_billing_reviews", version: 1, value: JSON.stringify([{ id: "review-1", recordType: "billing-review", reviewState: "pending" }]) }]);
    throw new Error(`Unexpected request ${href}`);
  };
  const req = request({ spsInvoiceId: "review-1", number: "INV-1001", lineItems: [{ kind: "product", qty: "1", unitPrice: "10" }] });
  req.body.trustedCanonicalInvoice = { id: "review-1" };
  req.body.billingReviewContext = { authorized: true };
  const out = res(); await createInvoice(req, out);
  assert.equal(out.statusCode, 409); assert.equal(out.body.code, "billing_review_confirmation_required");
  assert.ok(seen.every(url => !url.includes("quickbooks.test")));
});

test("recovery posts the saved QB wire payload without rebuilding customers, items, or tax", async () => {
  const wire = { CustomerRef: { value: "c1" }, DocNumber: "INV-1002", TxnDate: "2026-10-05", Line: [{ Amount: 10, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "item-original" }, Qty: 1, UnitPrice: 10 } }] };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url); calls.push({ href, method: options.method || "GET", body: options.body });
    if (href.endsWith("/auth/v1/user")) return response({ id: "owner", email: "owner@example.test" });
    if (href.includes("/qb_tokens?")) return response(tokens);
    if (href.includes("/invoice?") || href.includes("/invoice/qb-1?")) return response({ Invoice: { ...wire, Id: "qb-1", TotalAmt: 10, Balance: 10 } });
    throw new Error(`Forbidden recovery lookup ${href}`);
  };
  const req = request({ spsInvoiceId: "review-1", qbCreateRequestKey: "frozen-key", number: "INV-1002", taxRate: 99, lineItems: [] });
  let journaled = false;
  req[BILLING_REVIEW_CREATE_CONTEXT] = { realmId: "realm", recovering: true, frozenQuickBooksInvoice: wire, beforeInvoiceWrite: async saved => { assert.deepEqual(saved, wire); journaled = true; } };
  const out = res(); await createInvoice(req, out);
  assert.equal(out.statusCode, 200); assert.equal(out.body.qbId, "qb-1"); assert.equal(journaled, true);
  const posts = calls.filter(call => call.method === "POST"); assert.equal(posts.length, 1); assert.deepEqual(JSON.parse(posts[0].body), wire);
  assert.match(posts[0].href, /requestid=sps-/); assert.equal(calls.some(call => /customer|item|send|email/.test(call.href)), false);
});

test("QB number inventory includes all pages and void invoices and fails on incomplete pages", async () => {
  let pages = 0;
  globalThis.fetch = async url => {
    const href = String(url);
    if (href.includes("/qb_tokens?")) return response(tokens);
    const query = new URL(href).searchParams.get("query");
    assert.doesNotMatch(query, /WHERE/i); pages += 1;
    if (pages === 1) return response({ QueryResponse: { Invoice: Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1), DocNumber: String(index + 1001), ...(index === 0 ? { TxnStatus: "Voided" } : {}) })) } });
    assert.match(query, /STARTPOSITION 1001/);
    return response({ QueryResponse: { Invoice: [{ Id: "1001", DocNumber: "2500" }] } });
  };
  const inventory = await readQuickBooksInvoiceNumberInventory();
  assert.equal(inventory.invoiceCount, 1001); assert.ok(inventory.numbers.includes("1001")); assert.ok(inventory.numbers.includes("2500")); assert.equal(pages, 2);
  globalThis.fetch = async url => String(url).includes("/qb_tokens?") ? response(tokens) : response({ Fault: { Error: [] } });
  await assert.rejects(readQuickBooksInvoiceNumberInventory(), /incomplete invoice inventory/);
});
