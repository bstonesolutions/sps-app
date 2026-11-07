import assert from "node:assert/strict";
import test from "node:test";
import { createBillingReviewHandler } from "../api/billing-review.js";
import { billingReviewAccountingIssue } from "../api/_billing-review-claims.js";
import { makeBillingReview } from "../billingReview.js";

const clone = value => structuredClone(value);
const now = "2026-11-06T18:00:00Z";
const response = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });

// A review whose QuickBooks create succeeded, but whose confirm was cut off before SPS recorded it.
function heldReview(id = "iv_scharf") {
  const base = makeBillingReview({
    id, clientId: "client-1", clientName: "Example Client", date: "11/05/2026", dueDate: "11/20/2026", taxRate: "0",
    sourceStopIds: ["stop-oct"], sourceCompletionReceiptIds: ["receipt-oct"],
    lineItems: [{ id: `${id}-line`, desc: "Monthly Service - October 2026", kind: "service", qty: "1", unitPrice: "175", taxable: false, maintenanceService: true, serviceMonth: "2026-10", sourceStopId: "stop-oct" }],
  }, { now });
  const invoice = { ...clone(base), status: "Draft", number: "INV-1634", billingReviewId: id };
  delete invoice.recordType; delete invoice.reviewState; delete invoice.reviewRevision;
  return { ...base, reviewState: "approving", reviewRevision: 3,
    approval: { attemptId: "attempt-1", number: "INV-1634", invoice, payload: { number: "INV-1634" }, state: "created", startedAt: "2026-11-05T15:00:00Z",
      writeStartedAt: "2026-11-05T15:00:02Z", leaseUntil: null,
      qbResult: { success: true, qbId: "3301", paymentLink: "https://pay.example/3301",
        invoice: { qbId: "3301", number: "INV-1634", status: "Open", total: 175, balance: 175, lineItems: [{ qbLineId: "1", desc: "Monthly Service - October 2026", qty: 1, unitPrice: 175, taxable: false }] } } } };
}

// The database guard's sps_invoice_financial_content (invoice_accounting_authority migration):
// a write whose result here is unchanged is accepted as a details-only change.
const FINANCIAL_KEYS = ["qbId", "qbCustomerId", "number", "clientId", "clientName", "date", "issueDate", "dueDate", "sentDate", "paidDate", "status",
  "taxRate", "taxAmount", "discountType", "discount", "invoiceDiscountType", "invoiceDiscount", "subTotal", "subtotal", "total", "balance", "items", "lines", "partial", "lateFeeAppliedAt"];
const NEUTRAL_LINE_KEYS = ["id", "unitCost", "costKnown", "knownUnitCost", "refId", "bundleItems", "bundleNote", "chargeType", "chargeLabel", "sourceEstimateLineId",
  "sourceVisitLineId", "sourceStopId", "sourceStopIds", "sourceCompletionReceiptId", "sourceCompletionReceiptIds", "serviceMonth", "sourceVisitDates", "maintenanceService"];
const financialContent = invoice => ({ ...Object.fromEntries(FINANCIAL_KEYS.filter(key => key in invoice).map(key => [key, invoice[key]])),
  lineItems: invoice.lineItems.map(line => Object.fromEntries(Object.entries(line).filter(([key]) => !NEUTRAL_LINE_KEYS.includes(key)))) });

// What QuickBooks sync stores for an invoice it has no SPS record for.
const imported = (overrides = {}) => ({ id: "qb_3301", qbId: "3301", number: "INV-1634", clientId: "client-1", clientName: "Example Client",
  source: "quickbooks", qbAuthoritative: true, qbSyncStatus: "synced", status: "Paid", total: 175, balance: 0, paymentLink: "https://pay.example/3301",
  lineItems: [{ id: "qbl_3301_1", qbLineId: "1", desc: "Monthly Service - October 2026", qty: 1, unitPrice: 175, taxable: false }], ...overrides });

function harness({ reviews, invoices }) {
  const rows = Object.fromEntries(Object.entries({ sps_billing_reviews: reviews, sps_invoices: invoices, sps_estimates: [], sps_schedule: [],
    sps_clients: [{ id: "client-1", name: "Example Client", history: [] }], sps_completed: {}, sps_invoicing: {}, sps_maintenance_billing: { version: 2, policies: {}, allocations: {} } })
    .map(([key, value]) => [key, { key, exists: true, version: 1, value: clone(value) }]));
  const apply = async operations => {
    if (operations.some(op => rows[op.key]?.version !== op.expectedVersion)) return { applied: false, outcome: "conflict" };
    for (const op of operations) if (!op.checkOnly) rows[op.key] = { key: op.key, exists: true, version: op.expectedVersion + 1, value: clone(op.value) };
    return { applied: true, currentVersions: {} };
  };
  const handler = createBillingReviewHandler({
    authorize: async () => ({ id: "owner", email: "owner@example.com" }),
    read: async keys => Object.fromEntries(keys.map(key => [key, clone(rows[key] || { key, exists: false, version: 0, value: null })])),
    cas: (key, version, value) => apply([{ key, expectedVersion: version, value }]), batch: apply, sharedBatch: apply,
    now: () => Date.parse(now), uuid: () => "unused", guard: async () => null,
    inventory: async () => { throw new Error("a recorded QuickBooks result never checks numbers again"); },
    createInvoice: async () => { throw new Error("a recorded QuickBooks result is never sent again"); },
  });
  return { rows, async retry(id = "iv_scharf") { const res = response(); await handler({ method: "POST", headers: {}, body: { action: "retry", reviewId: id } }, res); return res; } };
}

test("a review whose invoice QuickBooks sync already imported finishes by adopting that copy", async () => {
  const h = harness({ reviews: [heldReview()], invoices: [imported(), { id: "other", qbId: "9", number: "INV-9" }] });
  const out = await h.retry();
  assert.equal(out.statusCode, 200, out.body?.error);
  const review = h.rows.sps_billing_reviews.value[0];
  assert.equal(review.reviewState, "synced");
  assert.equal(review.linkedInvoiceId, "qb_3301");
  assert.equal(review.claimInvoiceId, "qb_3301");
  assert.equal(out.body.invoice.id, "qb_3301");

  const invoices = h.rows.sps_invoices.value;
  assert.equal(invoices.length, 2, "no second SPS invoice for the same QuickBooks invoice");
  const adopted = invoices.find(row => row.id === "qb_3301");
  // Everything QuickBooks owns stays exactly as imported (here: already paid).
  for (const key of ["qbId", "number", "clientId", "clientName", "status", "total", "balance", "paymentLink", "source", "qbAuthoritative"]) assert.deepEqual(adopted[key], imported()[key], key);
  assert.deepEqual(adopted.lineItems.map(({ desc, qty, unitPrice, taxable, qbLineId, id }) => ({ desc, qty, unitPrice, taxable, qbLineId, id })),
    imported().lineItems.map(({ desc, qty, unitPrice, taxable, qbLineId, id }) => ({ desc, qty, unitPrice, taxable, qbLineId, id })));
  assert.deepEqual(financialContent(adopted), financialContent(imported()), "the database guard sees no accounting change");
  // The review's own details are added.
  assert.equal(adopted.billingReviewId, "iv_scharf");
  assert.deepEqual(adopted.sourceStopIds, ["stop-oct"]);
  assert.deepEqual(adopted.sourceCompletionReceiptIds, ["receipt-oct"]);
  assert.equal(adopted.lineItems[0].maintenanceService, true);
  assert.equal(adopted.lineItems[0].serviceMonth, "2026-10");
  assert.equal(adopted.lineItems[0].sourceStopId, "stop-oct");

  // Retrying again just reports the finished link.
  const again = await h.retry();
  assert.equal(again.statusCode, 200, again.body?.error);
  assert.equal(again.body.invoice.id, "qb_3301");

  // Later edits to the adopted invoice are not blocked as "another billing approval's number".
  assert.equal(billingReviewAccountingIssue({ id: "qb_3301", spsInvoiceId: "qb_3301", number: "INV-1634", lineItems: [] }, h.rows.sps_billing_reviews.value, invoices), null);
});

test("an import with no client match is adopted without changing its protected client", async () => {
  const h = harness({ reviews: [heldReview()], invoices: [imported({ clientId: null })] });
  const out = await h.retry();
  assert.equal(out.statusCode, 200, out.body?.error);
  assert.equal(h.rows.sps_invoices.value[0].clientId, null);
  assert.equal(h.rows.sps_invoices.value[0].billingReviewId, "iv_scharf");
});

test("a copy that belongs to another client or review is never adopted", async () => {
  for (const [invoices, reviews] of [
    [[imported({ clientId: "client-2" })], [heldReview()]],
    [[imported({ billingReviewId: "iv_other" })], [heldReview()]],
    [[imported()], [heldReview(), { ...heldReview("iv_other"), reviewState: "synced", linkedInvoiceId: "qb_3301" }]],
    [[{ ...imported(), id: "manual-1" }], [heldReview()]],
  ]) {
    const h = harness({ reviews, invoices });
    const before = clone(h.rows.sps_invoices.value);
    const out = await h.retry();
    assert.equal(out.statusCode, 503);
    assert.match(out.body.error, /QuickBooks created this invoice \(INV-1634\), but SPS already has a different record for it\. Open invoice INV-1634 to check it\. Nothing was billed twice\./);
    assert.deepEqual(h.rows.sps_invoices.value, before);
    assert.equal(h.rows.sps_billing_reviews.value[0].reviewState, "approving");
  }
});

test("the receipt-saved invoice under the review's own identity still finishes as before", async () => {
  const saved = { ...imported(), id: "iv_scharf", source: "sps", billingReviewId: "iv_scharf" };
  const h = harness({ reviews: [heldReview()], invoices: [saved] });
  const out = await h.retry();
  assert.equal(out.statusCode, 200, out.body?.error);
  assert.deepEqual(h.rows.sps_invoices.value, [saved]);
  assert.equal(h.rows.sps_billing_reviews.value[0].linkedInvoiceId, "iv_scharf");
  assert.equal(h.rows.sps_billing_reviews.value[0].claimInvoiceId, undefined);
});
