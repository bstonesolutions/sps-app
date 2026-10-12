import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { billingReviewSaveReceiptMatches } from "../billingReviewReceipt.js";
import { sanitizeBillingReviewEdit } from "../api/billing-review.js";

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const review = {
  id: "review-1", clientId: "client-1", recordType: "billing-review", number: "", status: "Review", reviewState: "pending", reviewRevision: 3,
  title: "Edited job", notes: "Please preserve this", taxRate: "6", lineItems: [
    { id: "line-1", desc: "Monthly service - October 2026", qty: 1, unitPrice: "150", maintenanceService: true, sourceStopId: "stop-1", sourceVisitDates: ["10/07/2026"] },
    { id: "line-2", desc: "Pump", qty: "1", unitPrice: "250", taxable: true, bundleItems: [{ id: "part-1", qty: 1, price: 250 }] },
  ],
};
const saved = { ...sanitizeBillingReviewEdit(review, review), reviewRevision: 4, reviewUpdatedAt: "2026-10-07T12:00:00Z" };

function handler(name, next, request, canonical, extra = {}) {
  const start = app.indexOf(`  const ${name} =`);
  const end = app.indexOf(`  const ${next} =`, start);
  assert.ok(start > 0 && end > start);
  const dependencies = {
    billingReviewSaveReceiptMatches,
    requestBillingReview: async payload => payload ? request(payload) : { ok: true, reviews: [canonical] },
    loadBillingReviews: async () => [canonical],
    setInvoiceEditor() {}, setBillingReviews() {}, setBillingReceipt() {}, setBillingReviewsError() {}, setBillingRefreshWarning() {},
    refreshBillingInvoiceState: async () => {}, onRefreshBillingState: async () => {},
    ...extra,
  };
  return new Function(...Object.keys(dependencies), `${app.slice(start, end)}; return ${name};`)(...Object.values(dependencies));
}

test("receipt recovery compares the actual endpoint edit projection without trusting revision alone", () => {
  assert.equal(billingReviewSaveReceiptMatches(review, saved), true);
  for (const change of [
    { id: "other-review" }, { clientId: "other-client" }, { reviewRevision: 3 }, { reviewRevision: "invalid" },
    { reviewState: "approving" }, { reviewState: "synced" }, { approval: { state: "unknown" } },
    { title: "Changed on another device" }, { taxRate: "7" }, { notes: "Different notes" },
    { lineItems: [...saved.lineItems].reverse() }, { lineItems: [saved.lineItems[0]] },
    { lineItems: [{ ...saved.lineItems[0], qty: 2 }, saved.lineItems[1]] },
    { lineItems: [saved.lineItems[0], { ...saved.lineItems[1], taxable: false }] },
  ]) assert.equal(billingReviewSaveReceiptMatches(review, { ...saved, ...change }), false, JSON.stringify(change));
});

test("recovery respects server-maintained source fields, rejected attempts, and nested object key ordering", () => {
  const requested = { ...review, lineItems: review.lineItems.map(line => ({ ...line, sourceStopId: "untrusted-source" })) };
  const canonical = { ...sanitizeBillingReviewEdit(review, requested), reviewRevision: 5, approval: { state: "rejected", number: "2001" } };
  canonical.lineItems[1].bundleItems[0] = { price: 250, qty: 1, id: "part-1" };
  assert.equal(billingReviewSaveReceiptMatches(requested, canonical), true);
  assert.equal(canonical.lineItems[0].sourceStopId, "stop-1");
  assert.equal(billingReviewSaveReceiptMatches({ ...requested, lineItems: [{ ...requested.lineItems[0], maintenanceService: false }, requested.lineItems[1]] }, canonical), false);
});

for (const [name, next] of [["mutateEstimateBillingReview", "saveConvertedInvoice"], ["mutateBillingReview", "migrateBillingReviews"]]) {
  test(`${name}: a committed save with a lost response adopts its newer revision, then can save again`, async () => {
    let calls = 0;
    const mutate = handler(name, next, async payload => {
      calls++;
      if (calls === 1) throw new Error("Response interrupted");
      assert.equal(payload.expectedRevision, 4);
      return { ok: true, review: { ...saved, reviewRevision: 5 } };
    }, saved);
    const recovered = await mutate("save", review);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.review.reviewRevision, 4);
    const nextSave = await mutate("save", recovered.review);
    assert.equal(nextSave.review.reviewRevision, 5);
    assert.equal(calls, 2);
  });

  test(`${name}: a real conflicting edit remains in the form and never claims success`, async () => {
    const failure = new Error("Review changed on another device");
    const mutate = handler(name, next, async () => { throw failure; }, { ...saved, notes: "Another user's notes" }, {
      setInvoiceEditor() { assert.fail("Typed changes must stay in the open form"); },
    });
    await assert.rejects(mutate("save", review), error => error === failure && !error.data?.review);
    assert.equal(review.notes, "Please preserve this");
  });

  test(`${name}: a discarded canonical review recovers a lost discard response without retrying the mutation`, async () => {
    let requests = 0;
    const canonical = { ...saved, reviewState: "discarded" };
    const mutate = handler(name, next, async () => { requests++; throw new Error("Response interrupted"); }, canonical);
    const result = await mutate("discard", review);
    assert.equal(result.ok, true);
    assert.equal(result.review.reviewState, "discarded");
    assert.equal(requests, 1);
  });
}
