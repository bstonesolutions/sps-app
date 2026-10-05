import test from "node:test";
import assert from "node:assert/strict";
import { billingReviewAccountingIssue, reserveDirectInvoiceAccountingClaim, settleDirectInvoiceAccountingClaim } from "../api/_billing-review-claims.js";
import { buildQuickBooksInvoicePayload } from "../quickbooksDraftSync.js";

const invoice = (id = "manual-1", number = "INV-1001") => ({ spsInvoiceId: id, clientId: "c1", qbCustomerId: "qb-c1", number, lineItems: [{ id: "line", description: "Repair", qty: "1", unitPrice: "100" }] });
function ledger(initial = []) {
  let rows = initial;
  let version = 1;
  let writes = 0;
  const read = async () => ({ sps_billing_reviews: { exists: true, version, value: structuredClone(rows) }, sps_invoices: { exists: true, version: 1, value: [] } });
  const batch = async operations => {
    const op = operations.find(row => row.key === "sps_billing_reviews");
    if (op.expectedVersion !== version) return { applied: false };
    rows = structuredClone(op.value); version += 1; writes += 1; return { applied: true };
  };
  return { read, batch, rows: () => rows, writes: () => writes };
}

test("direct creates use the same CAS number fence as billing reviews", async () => {
  const state = ledger();
  const outcomes = await Promise.allSettled([
    reserveDirectInvoiceAccountingClaim(invoice("a"), { ...state, requestKey: "a" }),
    reserveDirectInvoiceAccountingClaim(invoice("b"), { ...state, requestKey: "b" }),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  assert.equal(state.rows().length, 1);
  assert.equal(state.rows()[0].approval.number, "INV-1001");
});

test("pending review and completed-source claims cannot be bypassed using a different invoice ID", async () => {
  for (const fields of [{ sourceStopIds: ["stop"] }, { sourceCompletionReceiptIds: ["receipt"] }, { sourceEstimateId: "estimate" }]) {
    const review = { id: "review", recordType: "billing-review", reviewState: "pending", ...fields };
    assert.ok(billingReviewAccountingIssue({ ...invoice(), ...fields }, [review]));
    const claim = { ...review, recordType: "invoice-number-claim", reviewState: "synced", approval: { number: "INV-99" } };
    assert.ok(billingReviewAccountingIssue({ ...invoice(), ...fields }, [claim]));
  }
  assert.ok(billingReviewAccountingIssue(invoice("review"), [{ id: "review", recordType: "billing-review", reviewState: "pending" }]));
});

test("same direct creation retries its intent, while changed payload or request key is refused", async () => {
  const state = ledger();
  const first = invoice();
  await reserveDirectInvoiceAccountingClaim(first, { ...state, requestKey: "original" });
  await reserveDirectInvoiceAccountingClaim(first, { ...state, requestKey: "original" });
  assert.equal(state.writes(), 1);
  await assert.rejects(reserveDirectInvoiceAccountingClaim({ ...first, number: "INV-1002" }, { ...state, requestKey: "original" }), /different creation request/);
  await assert.rejects(reserveDirectInvoiceAccountingClaim(first, { ...state, requestKey: "new-key" }), /different creation request/);
  assert.equal(state.rows()[0].createIntent.requestKey, "original");
});

test("normal QB updates retain all previously claimed invoice numbers", async () => {
  const state = ledger();
  await reserveDirectInvoiceAccountingClaim(invoice(), { ...state, requestKey: "original" });
  await reserveDirectInvoiceAccountingClaim({ ...invoice("manual-1", "INV-1005"), qbId: "qb1" }, { ...state, mode: "update", requestKey: "update:qb1" });
  assert.deepEqual(state.rows()[0].numberClaims, ["INV-1001", "INV-1005"]);
  assert.ok(billingReviewAccountingIssue(invoice("someone-else", "1001"), state.rows()));
  assert.ok(billingReviewAccountingIssue(invoice("someone-else", "1005"), state.rows()));
});

test("known rejected creates accept corrections with a new stable request key and retain numbers", async () => {
  const state = ledger();
  const first = await reserveDirectInvoiceAccountingClaim(invoice(), { ...state, requestKey: "original" });
  await settleDirectInvoiceAccountingClaim(first, { state: "rejected", httpStatus: 400 }, state);
  const corrected = invoice("manual-1", "INV-1002");
  const second = await reserveDirectInvoiceAccountingClaim(corrected, { ...state, requestKey: "original" });
  assert.notEqual(second.createIntent.requestKey, first.createIntent.requestKey);
  assert.equal(second.createIntent.state, "prepared");
  assert.deepEqual(second.numberClaims, ["INV-1001", "INV-1002"]);
  assert.equal(second.previousCreateIntents[0].state, "rejected");
  const retry = await reserveDirectInvoiceAccountingClaim(corrected, { ...state, requestKey: "original" });
  assert.equal(retry.createIntent.requestKey, second.createIntent.requestKey);
  assert.equal(await settleDirectInvoiceAccountingClaim(first, { state: "unknown" }, state), false);
  await settleDirectInvoiceAccountingClaim(second, { state: "created", qbId: "qb2" }, state);
  await settleDirectInvoiceAccountingClaim(second, { state: "unknown" }, state);
  assert.equal(state.rows()[0].createIntent.state, "created");
});

test("unknown creates reject edited input and retry their original frozen wire", async () => {
  const state = ledger();
  const wire = { CustomerRef: { value: "qb-c1" }, DocNumber: "INV-1001", Line: [{ Amount: 100 }] };
  const first = await reserveDirectInvoiceAccountingClaim(invoice(), { ...state, requestKey: "original", quickBooksInvoice: wire, realmId: "company" });
  await settleDirectInvoiceAccountingClaim(first, { state: "unknown" }, state);
  await assert.rejects(reserveDirectInvoiceAccountingClaim(invoice("manual-1", "INV-1002"), { ...state, requestKey: "original" }), /different creation request/);
  const retry = await reserveDirectInvoiceAccountingClaim(invoice(), { ...state, requestKey: "original", quickBooksInvoice: { ...wire, Line: [{ Amount: 200 }] }, realmId: "company" });
  assert.deepEqual(retry.createIntent.quickBooksInvoice, wire);
});

test("missing numbers cannot poison the shared completion ledger", async () => {
  const state = ledger();
  await assert.rejects(reserveDirectInvoiceAccountingClaim(invoice("manual-1", ""), { ...state, requestKey: "original" }), /Choose an invoice number/);
  assert.equal(state.writes(), 0);
});

test("discarded reviews allow deliberate different-ID manual billing, while keeping claimed numbers", () => {
  const review = { id: "discarded", recordType: "billing-review", reviewState: "discarded", sourceEstimateId: "estimate", approval: { number: "INV-99" } };
  assert.equal(billingReviewAccountingIssue({ ...invoice(), sourceEstimateId: "estimate" }, [review]), null);
  assert.ok(billingReviewAccountingIssue(invoice("discarded"), [review]));
  assert.ok(billingReviewAccountingIssue(invoice("manual-1", "INV-99"), [review]));
});

test("verified recreation starts a new intent and retains its earlier evidence", async () => {
  const state = ledger();
  await reserveDirectInvoiceAccountingClaim(invoice(), { ...state, requestKey: "original" });
  await reserveDirectInvoiceAccountingClaim(invoice(), { ...state, requestKey: "manual-1:recreate:old-qb", verifyRecreation: async () => true });
  assert.equal(state.rows()[0].previousCreateIntents[0].requestKey, "original");
});

test("negative completed-service adjustments preserve the actual charge in QB payload", () => {
  const payload = buildQuickBooksInvoicePayload({ ...invoice(), lineItems: [
    { desc: "Repair", qty: "1", unitPrice: "100", kind: "service", taxable: false },
    { desc: "Service price adjustment", qty: "1", unitPrice: "-20", kind: "service", taxable: false },
  ] }, null, {});
  assert.equal(payload.lineItems[1].unitPrice, "-20.00");
  assert.equal(payload.lineItems.reduce((sum, line) => sum + Number(line.qty) * Number(line.unitPrice), 0), 80);
});
