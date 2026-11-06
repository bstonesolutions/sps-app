import assert from "node:assert/strict";
import test from "node:test";
import { createBillingReviewHandler } from "../api/billing-review.js";
import { BILLING_REVIEW_CREATE_CONTEXT } from "../api/_billing-review-context.js";
import { makeBillingReview, planBillingReviewMerge } from "../billingReview.js";
import { invoiceCompletedVisitSources } from "../invoiceVisitImport.js";
import { isMaintenanceServiceLine } from "../maintenanceServiceLine.js";
import { invoiceServiceLineMonths } from "../invoiceServiceDescription.js";

const clone = value => structuredClone(value);
const now = "2026-11-06T14:00:00Z";
const response = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });

const closing = (overrides = {}) => makeBillingReview({
  id: "iv_stop_close", clientId: "client-1", clientName: "Example Client", date: "11/05/2026", dueDate: "11/20/2026",
  source: "completed-stop", sourceStopId: "stop-close", sourceCompletionReceiptId: "receipt-close", sourceVisitClientIds: ["client-1"],
  taxRate: "6", notes: "Thank you for your business.",
  lineItems: [{ id: "line-close", desc: "Pool closing", kind: "service", qty: "1", unitPrice: "350", taxable: false, sourceStopId: "stop-close", sourceCompletionReceiptId: "receipt-close" }],
  ...overrides,
}, { now });

const october = (overrides = {}) => makeBillingReview({
  id: "iv_maint_client-1_2026-10", clientId: "client-1", clientName: "Example Client", date: "11/01/2026", dueDate: "11/16/2026",
  source: "monthly-maintenance", autoPeriod: "2026-10", sourceStopIds: ["stop-oct-1", "stop-oct-2"], sourceCompletionReceiptIds: ["receipt-oct-1", "receipt-oct-2"],
  taxRate: "6", notes: "Thank you for your business.",
  lineItems: [{ id: "il_maint_client-1_2026-10_service", desc: "Monthly service", kind: "service", qty: "1", unitPrice: "200", taxable: false, sourceStopIds: ["stop-oct-1", "stop-oct-2"], sourceCompletionReceiptIds: ["receipt-oct-1", "receipt-oct-2"] }],
  ...overrides,
}, { now });

function harness({ reviews = [october(), closing()], schedule = [], estimates = [], completed = {} } = {}) {
  const values = {
    sps_billing_reviews: reviews, sps_invoices: [], sps_estimates: estimates, sps_schedule: schedule,
    sps_clients: [{ id: "client-1", name: "Example Client", qbId: "customer-1", history: [] }], sps_completed: completed,
    sps_invoicing: { nextNumber: 1001, numberPrefix: "INV-", dueDays: 15 }, sps_maintenance_billing: { version: 2, policies: {}, allocations: {} },
  };
  const rows = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { key, exists: true, version: 1, value: clone(value) }]));
  const calls = { posts: [], writes: [] };
  const apply = async operations => {
    if (operations.some(op => rows[op.key]?.version !== op.expectedVersion)) return { applied: false, outcome: "conflict" };
    for (const op of operations) if (!op.checkOnly) {
      rows[op.key] = { key: op.key, exists: true, version: op.expectedVersion + 1, value: clone(op.value) };
      calls.writes.push(op.key);
    }
    return { applied: true, currentVersions: Object.fromEntries(operations.map(op => [op.key, rows[op.key].version])) };
  };
  let counter = 0;
  const handler = createBillingReviewHandler({
    authorize: async () => ({ id: "owner", email: "owner@example.com" }),
    read: async keys => Object.fromEntries(keys.map(key => [key, clone(rows[key] || { key, exists: false, version: 0, value: null })])),
    cas: (key, version, value) => apply([{ key, expectedVersion: version, value }]), batch: apply,
    sharedBatch: (operations, scope) => {
      for (const key of Object.keys(scope.expectedCurrent)) assert.deepEqual(scope.expectedCurrent[key], rows[key].value);
      return apply(operations);
    },
    inventory: async () => ({ realmId: "realm-1", numbers: [], checkedAt: now }),
    guard: async () => null, now: () => Date.parse(now), uuid: () => `attempt-${++counter}`,
    createInvoice: async (req, res) => {
      const context = req[BILLING_REVIEW_CREATE_CONTEXT];
      const payload = clone(req.body.invoice);
      await context.beforeInvoiceWrite({ DocNumber: payload.number }, { realmId: "realm-1", qbRequestId: payload.qbCreateRequestKey });
      context.writeStarted = true;
      calls.posts.push(payload);
      return res.status(200).json({ success: true, qbId: `qb-${payload.spsInvoiceId}`, qbContentFingerprint: "fp", invoice: { qbId: `qb-${payload.spsInvoiceId}`, number: payload.number, status: "Draft", lineItems: payload.lineItems } });
    },
  });
  return { rows, calls, review: id => rows.sps_billing_reviews.value.find(row => row.id === id),
    async call(body) { const res = response(); await handler({ method: "POST", headers: {}, body }, res); return res; } };
}

const mergeBody = (target, others) => ({ action: "merge", reviewId: target.id, expectedRevision: target.reviewRevision,
  mergeReviews: others.map(review => ({ id: review.id, expectedRevision: review.reviewRevision })) });

test("merging a closing into October maintenance keeps both visits on one review", async () => {
  const stop = { sid: "stop-close", clientId: "client-1", linkedBillingReviewId: "iv_stop_close" };
  const h = harness({ schedule: [{ date: "11/05/2026", stops: [stop] }] });
  // The owner opened the closing; the maintenance review survives so completion still finds its period.
  const result = await h.call(mergeBody(closing(), [october()]));
  assert.equal(result.statusCode, 200, result.body?.error);
  const merged = h.review("iv_maint_client-1_2026-10");
  assert.equal(result.body.review.id, merged.id);
  assert.equal(merged.reviewState, "pending");
  assert.equal(merged.reviewRevision, 2);
  assert.deepEqual(merged.lineItems.map(line => line.desc), ["Monthly service", "Pool closing"]);
  assert.deepEqual(invoiceCompletedVisitSources(merged).sourceStopIds.sort(), ["stop-close", "stop-oct-1", "stop-oct-2"]);
  assert.deepEqual(invoiceCompletedVisitSources(merged).sourceCompletionReceiptIds.sort(), ["receipt-close", "receipt-oct-1", "receipt-oct-2"]);
  assert.deepEqual(merged.reviewMergedFrom, ["iv_stop_close"]);
  assert.equal(merged.notes, "Thank you for your business.");

  const tombstone = h.review("iv_stop_close");
  assert.equal(tombstone.reviewState, "discarded");
  assert.equal(tombstone.discardReason, "merged");
  assert.equal(tombstone.reviewMergedInto, merged.id);
  assert.equal(invoiceCompletedVisitSources(tombstone).hasSources, false);
  assert.equal(tombstone.billingReviewAudit.mergedInto.moved.lineItems[0].desc, "Pool closing");
  assert.equal(h.rows.sps_schedule.value[0].stops[0].linkedBillingReviewId, merged.id);
});

test("each moved line keeps whether it is a maintenance charge", () => {
  const extra = closing({ lineItems: [
    { id: "line-extra", desc: "Extra visit", kind: "service", qty: "1", unitPrice: "90", taxable: false },
    { id: "line-close", desc: "Pool closing", kind: "service", qty: "1", unitPrice: "350", taxable: false },
  ] });
  const { survivor } = planBillingReviewMerge({ target: october(), others: [extra], now });
  const moved = survivor.lineItems.find(line => line.desc === "Extra visit");
  assert.equal(moved.billSeparately, true);
  assert.equal(isMaintenanceServiceLine(survivor, moved), false);
  assert.equal(isMaintenanceServiceLine(survivor, survivor.lineItems[0]), true);
  assert.equal(survivor.lineItems.find(line => line.desc === "Pool closing").billSeparately, undefined);

  const estimate = closing({ id: "iv_est_1", source: "estimate", sourceEstimateId: "estimate-1", lineItems: [{ id: "est-line", desc: "Heater install", kind: "service", qty: "1", unitPrice: "900", taxable: false }] });
  // "Pool care" is maintenance only because its review was a monthly maintenance review.
  const care = october({ lineItems: [{ id: "care", desc: "Pool care", kind: "service", qty: "1", unitPrice: "200", taxable: false }] });
  const intoEstimate = planBillingReviewMerge({ target: care, others: [estimate], now });
  assert.equal(intoEstimate.survivor.id, "iv_est_1");
  const maintenance = intoEstimate.survivor.lineItems.find(line => line.desc === "Pool care");
  assert.equal(maintenance.maintenanceService, true);
  assert.equal(maintenance.serviceMonth, "2026-10");
  assert.deepEqual(invoiceServiceLineMonths(intoEstimate.survivor, maintenance), ["2026-10"]);
});

test("line IDs stay unique and the open review survives when neither is special", () => {
  const first = closing({ id: "review-a", sourceStopId: "stop-a", lineItems: [{ id: "line-1", desc: "Pump repair", kind: "service", qty: "1", unitPrice: "100" }] });
  const second = closing({ id: "review-b", sourceStopId: "stop-b", notes: "Bring the spare key.", lineItems: [{ id: "line-1", desc: "Filter clean", kind: "service", qty: "1", unitPrice: "60" }] });
  const { survivor, mergedIds } = planBillingReviewMerge({ target: second, others: [first], now });
  assert.equal(survivor.id, "review-b");
  assert.deepEqual(mergedIds, ["review-a"]);
  assert.deepEqual(survivor.lineItems.map(line => line.id), ["line-1", "line-1_merged_1"]);
  assert.equal(survivor.notes, "Bring the spare key.\n\nThank you for your business.");
});

test("merge refuses what it cannot combine without changing the bill", async () => {
  const cases = [
    [closing({ clientId: "client-2" }), 409, "billing_review_merge_client"],
    [{ ...closing(), reviewState: "approving" }, 409, "billing_review_locked"],
    [closing({ taxRate: "0", lineItems: [{ id: "line-close", desc: "Chlorine", kind: "product", qty: "1", unitPrice: "30", taxable: true }] }), 422, "billing_review_merge_tax",
      october({ lineItems: [...october().lineItems, { id: "salt", desc: "Salt", kind: "product", qty: "2", unitPrice: "12", taxable: true }] })],
    [closing({ discountType: "pct", discount: "10" }), 422, "billing_review_merge_discount"],
  ];
  for (const [other, status, code, target = october()] of cases) {
    const h = harness({ reviews: [target, other] });
    const result = await h.call(mergeBody(target, [other]));
    assert.equal(result.statusCode, status, code);
    assert.equal(result.body.code, code);
    assert.deepEqual(h.calls.writes, []);
  }
  const taxedOnlyThere = planBillingReviewMerge({ target: october(), others: [closing({ taxRate: "0", lineItems: [{ id: "line-close", desc: "Chlorine", kind: "product", qty: "1", unitPrice: "30", taxable: true }] })], now });
  assert.equal(taxedOnlyThere.survivor.taxRate, "0");
  const estimates = [closing({ id: "iv_est_1", sourceEstimateId: "estimate-1" }), closing({ id: "iv_est_2", sourceEstimateId: "estimate-2" })];
  assert.throws(() => planBillingReviewMerge({ target: estimates[0], others: [estimates[1]], now }), error => error.code === "billing_review_merge_estimates");
  const stale = harness();
  const result = await stale.call({ ...mergeBody(october(), [closing()]), mergeReviews: [{ id: "iv_stop_close", expectedRevision: 7 }] });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "billing_review_changed");
});

test("the merged review confirms as one invoice and later saves keep line provenance", async () => {
  const completed = {
    "stop-close": { receiptId: "receipt-close" }, "stop-oct-1": { receiptId: "receipt-oct-1" }, "stop-oct-2": { receiptId: "receipt-oct-2" },
  };
  const extra = closing({ lineItems: [{ id: "line-extra", desc: "Extra visit", kind: "service", qty: "1", unitPrice: "90", taxable: false, sourceStopId: "stop-close", sourceCompletionReceiptId: "receipt-close" }] });
  const h = harness({ reviews: [october(), extra], completed });
  assert.equal((await h.call(mergeBody(october(), [extra]))).statusCode, 200);
  const merged = h.review("iv_maint_client-1_2026-10");
  // An older editor that drops the flags and source fields cannot strip them on save.
  const edited = { ...merged, lineItems: merged.lineItems.map(({ billSeparately, maintenanceService, sourceStopId, sourceStopIds, sourceCompletionReceiptId, sourceCompletionReceiptIds, ...line }) => line) };
  const saved = await h.call({ action: "save", reviewId: merged.id, expectedRevision: merged.reviewRevision, review: edited });
  assert.equal(saved.statusCode, 200, saved.body?.error);
  const extraLine = saved.body.review.lineItems.find(line => line.id === "line-extra");
  assert.equal(extraLine.billSeparately, true);
  assert.equal(extraLine.sourceStopId, "stop-close");

  const confirmed = await h.call({ action: "confirm", reviewId: merged.id, expectedRevision: saved.body.review.reviewRevision });
  assert.equal(confirmed.statusCode, 200, confirmed.body?.error);
  assert.equal(h.calls.posts.length, 1);
  assert.deepEqual(h.calls.posts[0].lineItems.map(line => line.id), ["il_maint_client-1_2026-10_service", "line-extra"]);
  const invoice = h.rows.sps_invoices.value.find(row => row.id === merged.id);
  assert.deepEqual(invoiceCompletedVisitSources(invoice).sourceStopIds.sort(), ["stop-close", "stop-oct-1", "stop-oct-2"]);
});
