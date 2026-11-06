import assert from "node:assert/strict";
import test from "node:test";
import { createBillingReviewHandler } from "../api/billing-review.js";
import { BILLING_REVIEW_CREATE_CONTEXT } from "../api/_billing-review-context.js";
import { makeBillingReview } from "../billingReview.js";

const clone = value => structuredClone(value);
const now = "2026-11-06T14:00:00Z";
const response = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });

const review = (id, overrides = {}) => makeBillingReview({
  id, clientId: "client-1", clientName: "Example Client", date: "11/05/2026", dueDate: "11/20/2026", taxRate: "0",
  lineItems: [{ id: `${id}-line`, desc: "Pool closing", kind: "service", qty: "1", unitPrice: "175", taxable: false }],
  ...overrides,
}, { now });

// The real QuickBooks create endpoint also returns the whole saved invoice ledger
// (invoiceRefresh) so a browser can refresh. A billing review must not keep it.
const ledger = Array.from({ length: 200 }, (_, index) => ({ id: `old-${index}`, number: `INV-${index}`, lineItems: [{ desc: "Monthly service", qty: 1, unitPrice: 175 }] }));

function harness(reviews) {
  const values = {
    sps_billing_reviews: reviews, sps_invoices: [], sps_estimates: [], sps_schedule: [],
    sps_clients: [{ id: "client-1", name: "Example Client", qbId: "customer-1", history: [] }], sps_completed: {},
    sps_invoicing: { nextNumber: 1001, numberPrefix: "INV-", dueDays: 15 }, sps_maintenance_billing: { version: 2, policies: {}, allocations: {} },
  };
  const rows = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { key, exists: true, version: 1, value: clone(value) }]));
  const apply = async operations => {
    if (operations.some(op => rows[op.key]?.version !== op.expectedVersion)) return { applied: false, outcome: "conflict" };
    for (const op of operations) if (!op.checkOnly) rows[op.key] = { key: op.key, exists: true, version: op.expectedVersion + 1, value: clone(op.value) };
    return { applied: true, currentVersions: Object.fromEntries(operations.map(op => [op.key, rows[op.key].version])) };
  };
  const handler = createBillingReviewHandler({
    authorize: async () => ({ id: "owner", email: "owner@example.com" }),
    read: async keys => Object.fromEntries(keys.map(key => [key, clone(rows[key] || { key, exists: false, version: 0, value: null })])),
    cas: (key, version, value) => apply([{ key, expectedVersion: version, value }]), batch: apply, sharedBatch: apply,
    inventory: async () => ({ realmId: "realm-1", numbers: [], checkedAt: now }),
    guard: async () => null, now: () => Date.parse(now), uuid: () => "attempt-1",
    createInvoice: async (req, res) => {
      const payload = clone(req.body.invoice);
      await req[BILLING_REVIEW_CREATE_CONTEXT].beforeInvoiceWrite({ DocNumber: payload.number }, { realmId: "realm-1", qbRequestId: "request-1" });
      return res.status(200).json({ success: true, qbId: "qb-1", paymentLink: "https://pay.example/1", qbContentFingerprint: "fp", qbRequestId: "request-1",
        invoice: { qbId: "qb-1", number: payload.number, status: "Draft", lineItems: payload.lineItems },
        invoiceRefresh: { ok: true, key: "sps_invoices", invoices: ledger, beforeVersion: 1, afterVersion: 2 } });
    },
  });
  return { rows, async call(body, method = "POST") { const res = response(); await handler({ method, headers: {}, body }, res); return res; } };
}

const size = value => JSON.stringify(value).length;

test("a confirmed review keeps the QuickBooks result but not a copy of every invoice", async () => {
  const h = harness([review("iv_stop_1")]);
  const confirmed = await h.call({ action: "confirm", reviewId: "iv_stop_1", expectedRevision: 1 });
  assert.equal(confirmed.statusCode, 200, confirmed.body?.error);
  const saved = h.rows.sps_billing_reviews.value.find(row => row.id === "iv_stop_1");
  assert.equal(saved.reviewState, "synced");
  assert.equal(saved.approval.qbResult.qbId, "qb-1");
  assert.equal(saved.approval.qbResult.paymentLink, "https://pay.example/1");
  assert.equal(saved.approval.qbResult.invoice.number, saved.approval.number);
  assert.equal(saved.approval.qbResult.invoiceRefresh, undefined);
  assert.equal(confirmed.body.review.approval.qbResult.invoiceRefresh, undefined);
  assert.ok(size(h.rows.sps_billing_reviews.value) < size(ledger), "the review list stays smaller than one invoice ledger copy");
});

test("reviews already carrying an invoice ledger copy are slimmed on the next read and write", async () => {
  const bloated = { ...review("iv_old", { reviewState: "synced" }), reviewState: "synced",
    approval: { attemptId: "old", state: "created", qbResult: { success: true, qbId: "qb-old", invoice: { qbId: "qb-old" }, invoiceRefresh: { ok: true, invoices: ledger } } } };
  const h = harness([bloated, review("iv_new")]);
  const listed = await h.call(undefined, "GET");
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.reviews.find(row => row.id === "iv_old").approval.qbResult.invoiceRefresh, undefined);
  assert.equal(listed.body.reviews.find(row => row.id === "iv_old").approval.qbResult.qbId, "qb-old");

  const saved = await h.call({ action: "save", reviewId: "iv_new", expectedRevision: 1, review: { ...review("iv_new"), notes: "Gate code 1234" } });
  assert.equal(saved.statusCode, 200, saved.body?.error);
  const old = h.rows.sps_billing_reviews.value.find(row => row.id === "iv_old");
  assert.equal(old.approval.qbResult.invoiceRefresh, undefined);
  assert.equal(old.approval.qbResult.qbId, "qb-old");
  assert.equal(old.reviewState, "synced");
});
