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
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ email: "owner@example.test", role: "owner" }]) }]);
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
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ email: "owner@example.test", role: "owner" }]) }]);
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

// A fake QuickBooks invoice collection: COUNT(*) reports `counted`, pages read `invoices`.
function quickBooksInvoices(invoices, { counted = invoices.length } = {}) {
  const seen = { pages: [], inFlight: 0, maxInFlight: 0 };
  globalThis.fetch = async url => {
    const href = String(url);
    if (href.includes("/qb_tokens?")) return response(tokens);
    const query = new URL(href).searchParams.get("query");
    assert.doesNotMatch(query, /WHERE/i);
    if (/COUNT\(\*\)/.test(query)) return response({ QueryResponse: { totalCount: counted } });
    const start = Number(query.match(/STARTPOSITION (\d+)/)[1]);
    assert.match(query, /MAXRESULTS 1000$/);
    seen.pages.push(start); seen.inFlight += 1; seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    seen.inFlight -= 1;
    return response({ QueryResponse: { Invoice: invoices.slice(start - 1, start + 999) } });
  };
  return seen;
}
const invoiceRows = count => Array.from({ length: count }, (_, index) => ({ Id: String(index + 1), DocNumber: String(index + 1001), ...(index === 0 ? { TxnStatus: "Voided" } : {}) }));

test("QB number inventory includes all pages and void invoices and fails on incomplete pages", async () => {
  const seen = quickBooksInvoices([...invoiceRows(1000), { Id: "1001", DocNumber: "2500" }]);
  const inventory = await readQuickBooksInvoiceNumberInventory();
  assert.equal(inventory.invoiceCount, 1001); assert.ok(inventory.numbers.includes("1001")); assert.ok(inventory.numbers.includes("2500"));
  assert.deepEqual(seen.pages.sort((a, b) => a - b), [1, 1001]);
  globalThis.fetch = async url => String(url).includes("/qb_tokens?") ? response(tokens) : response({ Fault: { Error: [] } });
  await assert.rejects(readQuickBooksInvoiceNumberInventory(), /incomplete invoice inventory/);
});

test("QB number inventory reads counted pages in parallel and still reaches the true end", async () => {
  const seen = quickBooksInvoices(invoiceRows(4500));
  const inventory = await readQuickBooksInvoiceNumberInventory();
  assert.equal(inventory.invoiceCount, 4500); assert.ok(inventory.numbers.includes("5500"));
  assert.deepEqual(seen.pages.sort((a, b) => a - b), [1, 1001, 2001, 3001, 4001]);
  assert.ok(seen.maxInFlight > 1 && seen.maxInFlight <= 4, `pages in flight: ${seen.maxInFlight}`);

  // Invoices created after the count fill the last counted page; keep reading until a short page.
  const grown = quickBooksInvoices(invoiceRows(2001), { counted: 1999 });
  const later = await readQuickBooksInvoiceNumberInventory();
  assert.equal(later.invoiceCount, 2001); assert.ok(later.numbers.includes("3001"));
  assert.deepEqual(grown.pages.sort((a, b) => a - b), [1, 1001, 2001]);

  quickBooksInvoices([{ Id: "1", DocNumber: "1001" }, { Id: "1", DocNumber: "1002" }]);
  await assert.rejects(readQuickBooksInvoiceNumberInventory(), /pagination could not be verified/);
});

// A late retry of a review write: QuickBooks is checked by the reserved number before re-sending.
function recoveryHarness({ found = null, lookupFails = false, postStatus = 200 } = {}) {
  const wire = { CustomerRef: { value: "c1" }, DocNumber: "INV-1002", TxnDate: "2026-10-05", Line: [{ Amount: 10, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "item-original" }, Qty: 1, UnitPrice: 10 } }] };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url); calls.push({ href, method: options.method || "GET" });
    if (href.endsWith("/auth/v1/user")) return response({ id: "owner", email: "owner@example.test" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ email: "owner@example.test", role: "owner" }]) }]);
    if (href.includes("/qb_tokens?")) return response(tokens);
    if (href.includes("/query?")) {
      if (lookupFails) return response({ Fault: { Error: [{ Message: "down" }] } }, 503);
      assert.match(decodeURIComponent(new URL(href).searchParams.get("query")), /^SELECT \* FROM Invoice WHERE DocNumber = 'INV-1002'$/);
      return response({ QueryResponse: found ? { Invoice: found } : {} });
    }
    if (options.method === "POST" && href.includes("/invoice?")) return postStatus === 200 ? response({ Invoice: { ...wire, Id: "qb-new", TotalAmt: 10, Balance: 10 } }) : response({ Fault: { Error: [{ Message: "Invalid Reference Id", Detail: "Item is inactive" }] } }, postStatus);
    if (href.includes("/invoice/")) { const id = href.match(/\/invoice\/([^?]+)/)[1]; return response({ Invoice: { ...wire, Id: id, TotalAmt: 10, Balance: 10 } }); }
    throw new Error(`Unexpected request ${href}`);
  };
  const req = request({ spsInvoiceId: "review-1", qbCreateRequestKey: "frozen-key", number: "INV-1002", lineItems: [] });
  let journaled = false;
  req[BILLING_REVIEW_CREATE_CONTEXT] = { realmId: "realm", recovering: true, frozenQuickBooksInvoice: wire, beforeInvoiceWrite: async () => { journaled = true; } };
  return { req, calls, wire, journaled: () => journaled };
}

test("a late retry adopts the invoice the first attempt created instead of sending it again", async () => {
  const h = recoveryHarness({ found: [{ Id: "qb-first", DocNumber: "INV-1002", CustomerRef: { value: "c1" }, TotalAmt: 12, Balance: 12, Line: [] }] });
  const out = res(); await createInvoice(h.req, out);
  assert.equal(out.statusCode, 200, out.body?.error); assert.equal(out.body.qbId, "qb-first");
  assert.equal(h.calls.filter(call => call.method === "POST").length, 0, "nothing is sent to QuickBooks again");
  assert.equal(h.req[BILLING_REVIEW_CREATE_CONTEXT].writeStarted, true);
});

test("a retry QuickBooks refuses after confirming no invoice exists is reported as safe to release", async () => {
  const h = recoveryHarness({ postStatus: 400 });
  const out = res(); await createInvoice(h.req, out);
  assert.equal(out.body.createRejected, true); assert.equal(out.body.recoveryAbsentConfirmed, true);
  assert.match(out.body.error, /Item is inactive/);
  assert.equal(h.journaled(), true);

  // Without a successful lookup, a refusal proves nothing about the first attempt.
  const unchecked = recoveryHarness({ lookupFails: true, postStatus: 400 });
  const second = res(); await createInvoice(unchecked.req, second);
  assert.equal(second.body.createRejected, true); assert.equal(second.body.recoveryAbsentConfirmed, undefined);
});

test("a number used by a different customer keeps the review held and sends nothing", async () => {
  const h = recoveryHarness({ found: [{ Id: "qb-other", DocNumber: "INV-1002", CustomerRef: { value: "someone-else" } }] });
  const out = res(); await createInvoice(h.req, out);
  assert.equal(out.statusCode, 409); assert.equal(out.body.createOutcomeUnknown, true);
  assert.match(out.body.error, /INV-1002/);
  assert.equal(h.calls.filter(call => call.method === "POST").length, 0);
});
