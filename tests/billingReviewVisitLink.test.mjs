import assert from "node:assert/strict";
import test from "node:test";
import { createBillingReviewHandler } from "../api/billing-review.js";
import { BILLING_REVIEW_CREATE_CONTEXT } from "../api/_billing-review-context.js";
import { makeBillingReview, planBillingReviewMerge } from "../billingReview.js";
import { completedVisitSource } from "../invoiceVisitImport.js";

const clone = value => structuredClone(value);
const now = "2026-11-06T14:00:00Z";
const response = () => ({ statusCode: 200, body: null, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });

const review = (id, overrides = {}) => makeBillingReview({
  id, clientId: "client-1", clientName: "Example Client", date: "11/05/2026", dueDate: "11/20/2026", taxRate: "0",
  lineItems: [{ id: `${id}-line`, desc: "Pond netting", kind: "service", qty: "1", unitPrice: "65", taxable: false }],
  ...overrides,
}, { now });

const september = { sid: "stop-sep", completionReceiptId: "receipt-sep", clientId: "client-1", date: "09/19/2026", type: "Pond cleanout", tech: "Crew" };
const october = { sid: "stop-oct", completionReceiptId: "receipt-oct", clientId: "client-1", date: "10/27/2026", type: "Fall Closing", tech: "Crew" };
const legacy = { clientId: "client-1", date: "08/02/2026", type: "Pond cleanout", tech: "Crew" };
const key = visit => completedVisitSource(visit, { clientId: "client-1" }).key;

function harness({ reviews, invoices = [], schedule = [], estimates = [], history = [september, october, legacy] }) {
  const values = {
    sps_billing_reviews: reviews, sps_invoices: invoices, sps_estimates: estimates, sps_schedule: schedule,
    sps_clients: [{ id: "client-1", name: "Example Client", qbId: "customer-1", history }],
    sps_completed: { "stop-sep": { receiptId: "receipt-sep" }, "stop-oct": { receiptId: "receipt-oct" } },
    sps_invoicing: { nextNumber: 1001, numberPrefix: "INV-", dueDays: 15 }, sps_maintenance_billing: { version: 2, policies: {}, allocations: {} },
  };
  const rows = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { key: name, exists: true, version: 1, value: clone(value) }]));
  const writes = [];
  const guardCalls = [];
  const apply = async operations => {
    if (operations.some(op => rows[op.key]?.version !== op.expectedVersion)) return { applied: false, outcome: "conflict" };
    for (const op of operations) if (!op.checkOnly) {
      writes.push(op.key);
      rows[op.key] = { key: op.key, exists: true, version: op.expectedVersion + 1, value: clone(op.value) };
    }
    return { applied: true, currentVersions: Object.fromEntries(operations.map(op => [op.key, rows[op.key].version])) };
  };
  const handler = createBillingReviewHandler({
    authorize: async () => ({ id: "owner", email: "owner@example.com" }),
    read: async keys => Object.fromEntries(keys.map(name => [name, clone(rows[name] || { key: name, exists: false, version: 0, value: null })])),
    cas: (name, version, value) => apply([{ key: name, expectedVersion: version, value }]), batch: apply, sharedBatch: apply,
    inventory: async () => ({ realmId: "realm-1", numbers: [], checkedAt: now }),
    guard: async (_invoice, options) => { guardCalls.push(options); return null; },
    now: () => Date.parse(now), uuid: () => "attempt-1",
    createInvoice: async (req, res) => {
      const context = req[BILLING_REVIEW_CREATE_CONTEXT];
      guardCalls.push({ fromCreate: true, snapshot: context.guardSnapshot });
      const payload = clone(req.body.invoice);
      await context.beforeInvoiceWrite({ DocNumber: payload.number }, { realmId: "realm-1", qbRequestId: "request-1" });
      // Like the real receipt writer: the confirmed invoice is already saved in SPS.
      const saved = { ...clone(context.canonicalInvoice), number: payload.number, qbId: "qb-1", status: "Draft" };
      await apply([{ key: "sps_invoices", expectedVersion: rows.sps_invoices.version, value: [saved, ...rows.sps_invoices.value] }]);
      return res.status(200).json({ success: true, qbId: "qb-1", paymentLink: "https://pay.example/1", qbRequestId: "request-1",
        invoice: { qbId: "qb-1", number: payload.number, status: "Draft", lineItems: payload.lineItems } });
    },
  });
  return {
    rows, writes, guardCalls,
    async call(body) { const res = response(); await handler({ method: "POST", headers: {}, body }, res); return res; },
    review(id) { return rows.sps_billing_reviews.value.find(row => row.id === id); },
  };
}

test("a client visit can be linked to a review without changing its charges", async () => {
  const h = harness({ reviews: [review("iv_manual")] });
  const before = h.review("iv_manual");
  const out = await h.call({ action: "link-visit", reviewId: "iv_manual", expectedRevision: before.reviewRevision, visitKey: key(september) });
  assert.equal(out.statusCode, 200, out.body?.error);
  const saved = h.review("iv_manual");
  assert.deepEqual(saved.sourceStopIds, ["stop-sep"]);
  assert.deepEqual(saved.sourceCompletionReceiptIds, ["receipt-sep"]);
  assert.deepEqual(saved.reviewLinkedVisits.map(row => row.key), [key(september)]);
  assert.equal(saved.reviewLinkedVisits[0].linkedBy, "owner@example.com");
  assert.equal(saved.reviewRevision, before.reviewRevision + 1);
  assert.deepEqual(saved.lineItems, before.lineItems);
  assert.equal(out.body.review.reviewRevision, saved.reviewRevision);
  assert.deepEqual(h.writes, ["sps_billing_reviews"], "only the review list is rewritten");

  const again = await h.call({ action: "link-visit", reviewId: "iv_manual", expectedRevision: saved.reviewRevision, visitKey: key(september) });
  assert.equal(again.statusCode, 200); assert.equal(again.body.changed, false);
});

test("a visit already claimed by another review or invoice cannot be linked", async () => {
  const other = review("iv_other", { sourceStopIds: ["stop-oct"], sourceCompletionReceiptIds: ["receipt-oct"] });
  const h = harness({ reviews: [review("iv_manual"), other] });
  const out = await h.call({ action: "link-visit", reviewId: "iv_manual", expectedRevision: 1, visitKey: key(october) });
  assert.equal(out.statusCode, 409);
  assert.match(out.body.error, /already has a billing review/);
  assert.equal(h.review("iv_manual").sourceStopIds, undefined);
  assert.deepEqual(h.writes, []);
});

test("a visit without a saved completion record is refused with a way forward", async () => {
  const h = harness({ reviews: [review("iv_manual")] });
  const out = await h.call({ action: "link-visit", reviewId: "iv_manual", expectedRevision: 1, visitKey: key(legacy) });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, "billing_review_visit_unverified");
  assert.match(out.body.error, /Bill anyway/);
  const missing = await h.call({ action: "link-visit", reviewId: "iv_manual", expectedRevision: 1, visitKey: "receipt:nope" });
  assert.equal(missing.statusCode, 409); assert.equal(missing.body.code, "billing_review_visit_missing");
  assert.deepEqual(h.writes, []);
});

test("only a hand-linked visit can be unlinked; the visit a review came from stays", async () => {
  const fromVisit = review("iv_stop_oct", { sourceStopIds: ["stop-oct"], sourceCompletionReceiptIds: ["receipt-oct"] });
  const h = harness({ reviews: [fromVisit] });
  const linked = await h.call({ action: "link-visit", reviewId: "iv_stop_oct", expectedRevision: 1, visitKey: key(september) });
  assert.equal(linked.statusCode, 200, linked.body?.error);
  assert.deepEqual(h.review("iv_stop_oct").sourceStopIds, ["stop-oct", "stop-sep"]);

  const original = await h.call({ action: "link-visit", reviewId: "iv_stop_oct", expectedRevision: 2, visitKey: key(october), linked: false });
  assert.equal(original.statusCode, 409); assert.equal(original.body.code, "billing_review_visit_original");

  const unlinked = await h.call({ action: "link-visit", reviewId: "iv_stop_oct", expectedRevision: 2, visitKey: key(september), linked: false });
  assert.equal(unlinked.statusCode, 200, unlinked.body?.error);
  const saved = h.review("iv_stop_oct");
  assert.deepEqual(saved.sourceStopIds, ["stop-oct"]);
  assert.deepEqual(saved.sourceCompletionReceiptIds, ["receipt-oct"]);
  assert.equal(saved.reviewLinkedVisits, undefined);
});

test("a review that is syncing or changed elsewhere refuses a link", async () => {
  const h = harness({ reviews: [review("iv_manual")] });
  const stale = await h.call({ action: "link-visit", reviewId: "iv_manual", expectedRevision: 0, visitKey: key(september) });
  assert.equal(stale.statusCode, 409); assert.equal(stale.body.code, "billing_review_changed");
  h.rows.sps_billing_reviews.value[0].reviewState = "approving";
  const locked = await h.call({ action: "link-visit", reviewId: "iv_manual", expectedRevision: 1, visitKey: key(september) });
  assert.equal(locked.statusCode, 409); assert.equal(locked.body.code, "billing_review_locked");
});

test("a linked visit carries into the confirmed invoice; confirm reuses its read and rewrites only what changed", async () => {
  const h = harness({ reviews: [review("iv_manual")], schedule: [{ date: "2026-10-27", stops: [{ sid: "stop-oct", clientId: "client-1" }] }] });
  const linked = await h.call({ action: "link-visit", reviewId: "iv_manual", expectedRevision: 1, visitKey: key(september) });
  assert.equal(linked.statusCode, 200, linked.body?.error);
  h.writes.length = 0;
  const versions = Object.fromEntries(Object.entries(h.rows).map(([name, row]) => [name, row.version]));

  const confirmed = await h.call({ action: "confirm", reviewId: "iv_manual", expectedRevision: 2 });
  assert.equal(confirmed.statusCode, 200, confirmed.body?.error);
  assert.equal(confirmed.body.review.reviewState, "synced");
  const invoice = h.rows.sps_invoices.value.find(row => row.id === "iv_manual");
  assert.deepEqual(invoice.sourceStopIds, ["stop-sep"]);
  assert.equal(invoice.reviewLinkedVisits, undefined, "review-only link notes stay off the invoice");
  assert.equal(confirmed.body.invoice.qbId, "qb-1");

  // The schedule and estimates had nothing linked to this review, so they were fenced, not uploaded again.
  assert.equal(h.rows.sps_schedule.version, versions.sps_schedule);
  assert.equal(h.rows.sps_estimates.version, versions.sps_estimates);
  assert.equal(h.writes.filter(name => name === "sps_invoices").length, 1, "only the QuickBooks receipt saved the invoice");
  assert.ok(!h.writes.includes("sps_schedule") && !h.writes.includes("sps_estimates") && !h.writes.includes("sps_clients"));

  // Both coverage checks used the rows confirm already read.
  assert.equal(h.guardCalls.filter(call => call.snapshot?.sps_clients?.value?.[0]?.id === "client-1").length, 2);
  assert.match(confirmed.headers["Server-Timing"], /read;dur=\d+.*quickbooks;dur=\d+.*promote;dur=\d+/);
});

test("confirm still links a stop that waits on the review", async () => {
  const waiting = { sid: "stop-nov", clientId: "client-1", linkedBillingReviewId: "iv_manual" };
  const h = harness({ reviews: [review("iv_manual")], schedule: [{ date: "2026-11-05", stops: [waiting] }, { date: "2026-11-06", stops: [{ sid: "other", clientId: "client-2" }] }] });
  const before = h.rows.sps_schedule.value;
  const confirmed = await h.call({ action: "confirm", reviewId: "iv_manual", expectedRevision: 1 });
  assert.equal(confirmed.statusCode, 200, confirmed.body?.error);
  const [linkedDay, otherDay] = h.rows.sps_schedule.value;
  assert.equal(linkedDay.stops[0].linkedInvoiceId, "iv_manual");
  assert.equal(linkedDay.stops[0].linkedBillingReviewId, undefined);
  assert.deepEqual(otherDay, before[1]);
});

test("merging keeps hand-linked visits unlinkable on the survivor", () => {
  const target = { ...review("iv_a"), reviewLinkedVisits: [{ key: key(september), sourceStopId: "stop-sep", sourceCompletionReceiptId: "receipt-sep" }], sourceStopIds: ["stop-sep"], sourceCompletionReceiptIds: ["receipt-sep"] };
  const other = { ...review("iv_b"), reviewLinkedVisits: [{ key: key(october), sourceStopId: "stop-oct", sourceCompletionReceiptId: "receipt-oct" }], sourceStopIds: ["stop-oct"], sourceCompletionReceiptIds: ["receipt-oct"] };
  const plan = planBillingReviewMerge({ target, others: [other], now: Date.parse(now) });
  assert.deepEqual(plan.survivor.reviewLinkedVisits.map(row => row.key).sort(), [key(october), key(september)].sort());
  assert.equal(plan.merged[0].reviewLinkedVisits, undefined);
  assert.deepEqual(plan.merged[0].billingReviewAudit.mergedInto.moved.reviewLinkedVisits.map(row => row.key), [key(october)]);
});

test("a held review is released for editing only when QuickBooks proved nothing was created", async () => {
  const held = (id, extra = {}) => ({ ...review(id), reviewState: "approving", reviewRevision: 2,
    approval: { attemptId: "old", requestKey: `${id}:approval:old`, number: "INV-1002", invoice: { id }, payload: { number: "INV-1002", lineItems: [] },
      quickBooksInvoice: { DocNumber: "INV-1002", CustomerRef: { value: "customer-1" } }, writeStartedAt: "2026-11-05T10:00:00Z", state: "unknown", leaseUntil: null, ...extra } });
  for (const [absent, expected] of [[true, "pending"], [false, "approving"]]) {
    const h = harness({ reviews: [held("iv_held")] });
    const handler = createBillingReviewHandler({
      authorize: async () => ({ id: "owner", email: "owner@example.com" }),
      read: async keys => Object.fromEntries(keys.map(name => [name, clone(h.rows[name] || { key: name, exists: false, version: 0, value: null })])),
      cas: async (name, version, value) => { h.rows[name] = { key: name, exists: true, version: version + 1, value: clone(value) }; return { applied: true }; },
      batch: async operations => { for (const op of operations) if (!op.checkOnly) h.rows[op.key] = { key: op.key, exists: true, version: op.expectedVersion + 1, value: clone(op.value) }; return { applied: true }; },
      now: () => Date.parse(now), uuid: () => "attempt-2", guard: async () => null, inventory: async () => ({ realmId: "realm-1", numbers: [], checkedAt: now }),
      createInvoice: async (req, res) => {
        assert.equal(req[BILLING_REVIEW_CREATE_CONTEXT].recovering, true);
        return res.status(500).json({ error: "QuickBooks rejected the invoice: Item is inactive", createRejected: true, ...(absent ? { recoveryAbsentConfirmed: true } : {}) });
      },
    });
    const out = response(); await handler({ method: "POST", headers: {}, body: { action: "retry", reviewId: "iv_held" } }, out);
    const saved = h.review("iv_held");
    assert.equal(saved.reviewState, expected);
    assert.match(saved.approval.error, /Item is inactive/);
    if (absent) {
      assert.equal(saved.approval.state, "rejected"); assert.equal(saved.approval.writeStartedAt, undefined);
      assert.equal(saved.approval.releasedWriteStartedAt, "2026-11-05T10:00:00Z");
      // Released reviews can be merged, edited, and confirmed again like any pending review.
      assert.doesNotThrow(() => planBillingReviewMerge({ target: saved, others: [review("iv_other")], now: Date.parse(now) }));
    } else {
      assert.equal(saved.approval.state, "unknown"); assert.equal(saved.approval.writeStartedAt, "2026-11-05T10:00:00Z");
    }
  }
});
