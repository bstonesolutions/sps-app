// The owner can bill an invoice SPS cannot match to maintenance coverage ("Bill anyway"), and link
// the visits it covers afterwards. The decision is honored only from the saved invoice or saved
// billing review; a request cannot grant it, borrow it for another client, or use it to create a
// second QuickBooks invoice.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { buildQuickBooksInvoicePayload } from "../quickbooksDraftSync.js";
import { fingerprintQuickBooksInvoiceContent } from "../api/quickbooks/invoice-revision.js";
import { maintenanceCoverageOverride, newMaintenanceCoverageOverride } from "../maintenanceCoverageOverride.js";
import { linkCompletedVisitsToInvoice, completedVisitInvoiceLink, invoiceCompletedVisitSources } from "../invoiceVisitImport.js";
import { assertInvoiceDeliveryCoverage } from "../invoiceDeliveryCoverage.js";
import { makeBillingReview } from "../billingReview.js";

// Server modules read these when they load, so import them only after the test values are set.
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.API_AUTH_ENFORCED = "true";
process.env.QB_API_BASE = "https://quickbooks.test";
const { createBillingReviewHandler } = await import("../api/billing-review.js");
const { default: createInvoice } = await import("../api/quickbooks/create-invoice.js");
const { default: updateInvoice } = await import("../api/quickbooks/update-invoice.js");
const { quickBooksMaintenanceGuard } = await import("../api/quickbooks/maintenance-guard.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const ownerChoice = { version: 1, at: "2026-11-06T15:00:00.000Z", by: "owner@example.test" };
const client = { id: "client-a", qbId: "customer-a", name: "Maple Court", monthlyRate: "175", planFreq: "Monthly", history: [] };
const serviceLine = { id: "line-a", desc: "Monthly maintenance - October 2026", kind: "service", qty: "1", unitPrice: "175", taxable: false, qbItemRef: { value: "item-1" } };
// October is already paid by this invoice, so a second October charge is normally refused.
const sourceInvoice = { id: "paid-source", number: "INV-PAID", clientId: client.id, date: "10/01/2026", dueDate: "10/01/2026", status: "Paid", balance: 0, total: 175, lineItems: [serviceLine] };
const draft = (extra = {}) => ({ id: "draft-a", number: "INV-NEW", clientId: client.id, date: "10/01/2026", dueDate: "10/15/2026", status: "Draft", lineItems: [serviceLine], ...extra });
const ledger = () => ({ version: 2, policies: {}, allocations: { [client.id]: { "2026-10": { status: "paid", expectedCents: 17500, allocatedCents: 17500, sources: [{ kind: "invoice", invoiceId: sourceInvoice.id, amountCents: 17500 }] } } } });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const res = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
const request = invoice => ({ method: "POST", headers: { authorization: "Bearer demo-token" }, body: { invoice } });
const qbInvoice = (id = "qb-draft") => ({
  Id: id, SyncToken: "1", CustomerRef: { value: client.qbId }, DocNumber: "INV-NEW", TxnDate: "2026-10-01", DueDate: "2026-10-15",
  Line: [{ Id: "1", DetailType: "SalesItemLineDetail", Amount: 175, Description: "Monthly maintenance", SalesItemLineDetail: { ItemRef: { value: "item-1" }, Qty: 1, UnitPrice: 175, TaxCodeRef: { value: "NON" } } }],
});
const qbWrites = calls => calls.filter(call => call.href.startsWith("https://quickbooks.test") && call.method !== "GET");

function install({ clients = [client], invoices = [sourceInvoice], billing = ledger(), existing = qbInvoice() } = {}) {
  const calls = [];
  let reviewClaims = [];
  let reviewVersion = 1;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || "GET", body: options.body });
    if (href.endsWith("/auth/v1/user")) return response({ id: "owner", email: "owner@example.test" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ email: "owner@example.test", role: "owner" }]) }]);
    if (href.endsWith("/rpc/sps_app_state_batch_cas")) {
      const operation = JSON.parse(options.body).p_operations.find(row => row.key === "sps_billing_reviews");
      if (operation.expected_version !== reviewVersion) return response([{ applied: false, outcome: "conflict" }]);
      reviewClaims = JSON.parse(operation.value); reviewVersion += 1;
      return response([{ applied: true, outcome: "applied", current_versions: { sps_billing_reviews: reviewVersion, sps_invoices: 1 } }]);
    }
    if (href.includes("/rest/v1/app_state?")) {
      if (href.includes("key=in.(sps_billing_reviews,sps_invoices)")) return response([
        { key: "sps_billing_reviews", value: JSON.stringify(reviewClaims), version: reviewVersion },
        { key: "sps_invoices", value: JSON.stringify(invoices), version: 1 },
      ]);
      return response(Object.entries({ sps_clients: clients, sps_invoices: invoices, sps_maintenance_billing: billing, sps_schedule: [] })
        .map(([key, value]) => ({ key, value: JSON.stringify(value), version: 1 })));
    }
    if (href.includes("/rest/v1/qb_tokens")) return response([{ id: "default", realm_id: "demo", access_token: "token", refresh_token: "refresh", expires_at: "2099-01-01T00:00:00Z" }]);
    if (href.includes("/customer/")) return response({ Customer: { Id: client.qbId } });
    if (href.includes("/invoice/") || href.includes("/invoice?")) return response({ Invoice: existing });
    throw new Error(`Unexpected fetch: ${href}`);
  };
  return calls;
}

test("an override is valid only when it records who chose it and when", () => {
  assert.equal(maintenanceCoverageOverride({ maintenanceCoverageOverride: ownerChoice }), ownerChoice);
  assert.equal(maintenanceCoverageOverride({ maintenanceCoverageOverride: true }), null);
  assert.equal(maintenanceCoverageOverride({ maintenanceCoverageOverride: { version: 1, at: "", by: "x" } }), null);
  assert.equal(maintenanceCoverageOverride({}), null);
  const made = newMaintenanceCoverageOverride("owner@example.test", Date.parse("2026-11-06T15:00:00Z"));
  assert.deepEqual(made, ownerChoice);
});

test("without the owner's choice an already-covered month is still refused", async () => {
  const calls = install({ invoices: [sourceInvoice, draft()] });
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(draft(), client, {})), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(qbWrites(calls).length, 0);
});

test("the saved owner choice lets the invoice reach QuickBooks", async () => {
  const saved = draft({ maintenanceCoverageOverride: ownerChoice });
  const calls = install({ invoices: [sourceInvoice, saved] });
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload(saved, client, {})), result);
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.ok(qbWrites(calls).some(call => call.href.includes("/invoice?")));
});

test("a request cannot grant itself the override; only the saved invoice can carry it", async () => {
  const calls = install({ invoices: [sourceInvoice, draft()] });
  const result = res();
  await createInvoice(request({ ...buildQuickBooksInvoicePayload(draft(), client, {}), maintenanceCoverageOverride: ownerChoice }), result);
  assert.equal(result.statusCode, 409);
  assert.equal(qbWrites(calls).length, 0);
});

test("another client's invoice cannot lend its override", async () => {
  // Client B's October is already paid, so only a borrowed override could let this through.
  const other = { ...client, id: "client-b", qbId: "customer-b", name: "Birch Court" };
  const otherPaid = { ...sourceInvoice, id: "paid-b", number: "INV-PAID-B", clientId: other.id };
  const billing = { version: 2, policies: {}, allocations: { [other.id]: { "2026-10": { status: "paid", expectedCents: 17500, allocatedCents: 17500, sources: [{ kind: "invoice", invoiceId: otherPaid.id, amountCents: 17500 }] } } } };
  const saved = draft({ maintenanceCoverageOverride: ownerChoice });
  const calls = install({ clients: [client, other], invoices: [otherPaid, saved], billing });
  const result = res();
  await createInvoice(request(buildQuickBooksInvoicePayload({ ...saved, clientId: other.id }, other, {})), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(qbWrites(calls).length, 0);
});

test("the override never allows a second QuickBooks invoice for one that is already linked", async () => {
  const saved = draft({ qbId: "qb-existing", maintenanceCoverageOverride: ownerChoice });
  const calls = install({ invoices: [sourceInvoice, saved] });
  const result = res();
  await createInvoice(request({ ...buildQuickBooksInvoicePayload(saved, client, {}), qbCreateRequestKey: "second-copy" }), result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "maintenance-invoice-already-linked");
  assert.equal(qbWrites(calls).length, 0);
});

test("with the override, a maintenance line no longer needs a service month to update QuickBooks", async () => {
  const undated = { ...serviceLine, desc: "Pond maintenance" };
  const blocked = draft({ qbId: "qb-draft", lineItems: [undated] });
  const existing = qbInvoice();
  let calls = install({ invoices: [sourceInvoice, blocked], existing, billing: { version: 2, policies: {}, allocations: {} } });
  let result = res();
  await updateInvoice(request({ ...buildQuickBooksInvoicePayload(blocked, client, {}), qbBaseContentFingerprint: fingerprintQuickBooksInvoiceContent(existing) }), result);
  assert.equal(result.statusCode, 422);
  assert.equal(result.body.code, "maintenance-service-month-missing");
  assert.equal(qbWrites(calls).length, 0);

  const allowed = { ...blocked, maintenanceCoverageOverride: ownerChoice };
  calls = install({ invoices: [sourceInvoice, allowed], existing, billing: { version: 2, policies: {}, allocations: {} } });
  result = res();
  await updateInvoice(request({ ...buildQuickBooksInvoicePayload(allowed, client, {}), qbBaseContentFingerprint: fingerprintQuickBooksInvoiceContent(existing) }), result);
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(qbWrites(calls).length, 1);
});

test("the guard accepts the override from a trusted billing review and reports it", async () => {
  install({ invoices: [sourceInvoice] });
  const review = draft({ id: "review-a", maintenanceCoverageOverride: ownerChoice });
  let reported = null;
  const issue = await quickBooksMaintenanceGuard(buildQuickBooksInvoicePayload(review, client, {}), {
    trustedCanonicalInvoice: review, onCoverageOverride: choice => { reported = choice; },
  });
  assert.equal(issue, null);
  assert.deepEqual(reported, ownerChoice);
  install({ invoices: [sourceInvoice] });
  const withoutChoice = await quickBooksMaintenanceGuard(buildQuickBooksInvoicePayload(draft({ id: "review-a" }), client, {}), { trustedCanonicalInvoice: draft({ id: "review-a" }) });
  assert.equal(withoutChoice?.code, "maintenance-already-covered");
});

test("sending the invoice by email skips the coverage hold for an overridden invoice", async () => {
  let ledgerLoads = 0;
  const invoice = draft({ maintenanceCoverageOverride: ownerChoice });
  const prepared = await assertInvoiceDeliveryCoverage({ invoice, client, clients: [client], invoices: [sourceInvoice, invoice], loadLedger: async () => { ledgerLoads += 1; return ledger(); } });
  assert.equal(prepared, invoice);
  assert.equal(ledgerLoads, 0);
  await assert.rejects(() => assertInvoiceDeliveryCoverage({ invoice: draft(), client, clients: [client], invoices: [sourceInvoice, draft()], loadLedger: async () => ledger() }), /already covered/);
});

// ── Billing review: the owner's choice is recorded by the server, then honored on confirm ──────
function reviewHarness(review, { guard } = {}) {
  const rows = {
    sps_billing_reviews: [review], sps_invoices: [], sps_estimates: [], sps_schedule: [],
    sps_clients: [{ id: "client-1", name: "Example Client", qbId: "customer-1", history: [] }], sps_completed: {},
    sps_invoicing: { nextNumber: 1001, numberPrefix: "INV-", dueDays: 15 }, sps_maintenance_billing: { version: 2, policies: {}, allocations: {} },
  };
  const versions = Object.fromEntries(Object.keys(rows).map(key => [key, 1]));
  const calls = { guard: [], posts: [] };
  const apply = async operations => {
    if (operations.some(op => versions[op.key] !== op.expectedVersion)) return { applied: false };
    for (const op of operations) if (!op.checkOnly) { rows[op.key] = structuredClone(op.value); versions[op.key] += 1; }
    return { applied: true, currentVersions: { ...versions } };
  };
  const handler = createBillingReviewHandler({
    authorize: async () => ({ id: "owner-id", email: "owner@example.test", teamRole: "owner" }),
    read: async keys => Object.fromEntries(keys.map(key => [key, { key, exists: true, version: versions[key], value: structuredClone(rows[key]) }])),
    cas: (key, version, value) => apply([{ key, expectedVersion: version, value }]), batch: apply, sharedBatch: apply,
    inventory: async () => ({ realmId: "realm-1", numbers: [], checkedAt: "2026-11-06T15:00:00.000Z" }),
    guard: async (payload, options) => { calls.guard.push(options); return guard ? guard(payload, options) : null; },
    now: () => Date.parse("2026-11-06T15:00:00Z"), uuid: () => "attempt-1",
    createInvoice: async (req, out) => {
      const context = req[Object.getOwnPropertySymbols(req).find(symbol => req[symbol]?.beforeInvoiceWrite)];
      await context.beforeInvoiceWrite({ DocNumber: req.body.invoice.number }, { qbRequestId: "request-1" });
      calls.posts.push(structuredClone(req.body.invoice));
      return out.status(200).json({ success: true, qbId: "qb-1", invoice: { qbId: "qb-1", number: req.body.invoice.number, status: "Draft", total: 100, balance: 100, lineItems: [] } });
    },
  });
  return {
    rows, calls,
    async call(body) { const out = res(); await handler({ method: "POST", headers: {}, body }, out); return out; },
  };
}
const monthlyReview = () => makeBillingReview({ id: "review-1", clientId: "client-1", clientName: "Example Client", date: "11/05/2026", dueDate: "11/20/2026", source: "monthly-maintenance", taxRate: "0",
  lineItems: [{ id: "line-1", desc: "Pond service", kind: "service", qty: "1", unitPrice: "100", taxable: false }] }, { now: "2026-11-05T14:00:00Z" });

test("the server records who chose to bill anyway; the request only turns it on or off", async () => {
  const h = reviewHarness(monthlyReview());
  const forged = { version: 1, at: "1999-01-01T00:00:00.000Z", by: "someone-else" };
  let result = await h.call({ action: "save", reviewId: "review-1", expectedRevision: 1, review: { ...monthlyReview(), maintenanceCoverageOverride: forged } });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.review.maintenanceCoverageOverride, ownerChoice);
  result = await h.call({ action: "save", reviewId: "review-1", expectedRevision: 2, review: { ...result.body.review, maintenanceCoverageOverride: null } });
  assert.equal(result.body.review.maintenanceCoverageOverride, undefined);
});

test("a confirmed review with the owner's choice reaches QuickBooks even without a service month", async () => {
  // Real guard contract: reports the override only from the trusted saved review.
  const guard = (_payload, options) => {
    if (maintenanceCoverageOverride(options.trustedCanonicalInvoice)) { options.onCoverageOverride?.(); return null; }
    return { status: 409, code: "maintenance-coverage-review", message: "Maintenance coverage needs review before this invoice can be billed." };
  };
  const blocked = reviewHarness(monthlyReview(), { guard });
  let result = await blocked.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(result.statusCode, 409);
  assert.equal(blocked.calls.posts.length, 0);

  const h = reviewHarness({ ...monthlyReview(), maintenanceCoverageOverride: ownerChoice }, { guard });
  result = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(h.calls.posts.length, 1);
  assert.deepEqual(h.calls.guard[0].trustedCanonicalInvoice.maintenanceCoverageOverride, ownerChoice);
  assert.deepEqual(result.body.invoice.maintenanceCoverageOverride, ownerChoice, "the final invoice keeps the decision for later sends");
});

// ── Linking visits after the invoice exists ─────────────────────────────────────────────────────
const visit = (id, extra = {}) => ({ sid: id, completionReceiptId: `receipt-${id}`, date: "10/14/2026", type: "Monthly Service", services: [], ...extra });

test("linking visits records them on the invoice without adding charges", () => {
  const invoice = { id: "inv-1", clientId: client.id, lineItems: [{ id: "l1", desc: "Pond service", qty: "1", unitPrice: "100" }] };
  const result = linkCompletedVisitsToInvoice(invoice, [visit("s1"), visit("s2")], { clientId: client.id });
  assert.deepEqual(result.invoice.lineItems, invoice.lineItems, "charges are unchanged");
  assert.deepEqual(result.invoice.sourceStopIds, ["s1", "s2"]);
  assert.deepEqual(result.invoice.sourceCompletionReceiptIds, ["receipt-s1", "receipt-s2"]);
  assert.equal(result.invoice.sourceVisitClientId, client.id);
  assert.equal(result.linkedVisitKeys.length, 2);
  // A visit with no billable items (covered maintenance) can still be linked.
  assert.equal(linkCompletedVisitsToInvoice(invoice, [visit("s3", { invoice: "$0" })], { clientId: client.id }).linkedVisitKeys.length, 1);
});

test("a linked visit reads as billed on that invoice and is not linked twice", () => {
  const invoice = linkCompletedVisitsToInvoice({ id: "inv-1", number: "INV-9", clientId: client.id, lineItems: [] }, [visit("s1")], { clientId: client.id }).invoice;
  assert.equal(invoiceCompletedVisitSources(invoice).hasSources, true);
  const link = completedVisitInvoiceLink(visit("s1"), [invoice], { clientId: client.id, currentInvoiceId: "inv-2" });
  assert.equal(link?.invoiceId, "inv-1");
  assert.equal(linkCompletedVisitsToInvoice(invoice, [visit("s1")], { clientId: client.id }).linkedVisitKeys.length, 0);
});
