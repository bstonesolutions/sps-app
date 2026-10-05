import test from "node:test";
import assert from "node:assert/strict";
import { makeBillingReview, planBillingReviewMigration, prepareEstimateBillingReview, collectBillingReviewNumberClaims } from "../billingReview.js";
import { planCompletionBillingReview } from "../completionInvoice.js";
import { applyStopCompletion } from "../stopCompletion.js";

const now = Date.parse("2026-10-05T12:00:00Z");
const client = { id: "c1", name: "Test Client", balance: "$25", history: [] };
const stop = { sid: "repair-1", clientId: "c1", type: "Repair" };
const base = { invoices: [], reviews: [], client, stop, schedule: [{ date: "10/05/2026", stops: [stop] }], completed: { "repair-1": { receiptId: "receipt-1" } }, entry: { invoice: "$125", completionReceiptId: "receipt-1" }, receiptId: "receipt-1", completedAt: new Date(now).toISOString(), now };

test("completion creates a separate unnumbered review and cannot change actual invoices", () => {
  const invoices = [{ id: "real", number: "INV-99", status: "Paid" }];
  const result = planCompletionBillingReview({ ...base, invoices });
  assert.strictEqual(result.invoices, invoices);
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].number, "");
  assert.equal(result.reviews[0].status, "Review");
  assert.equal(result.reviews[0].reviewRevision, 1);
  assert.equal(result.reviews[0].lineItems[0].unitPrice, "125");
  assert.equal(result.outcome.billingReviewId, "iv_stop_repair-1");
  const replay = planCompletionBillingReview({ ...base, reviews: result.reviews });
  assert.equal(replay.changed, false);
  assert.deepEqual(replay.reviews, result.reviews);
});

test("owner deletion leaves a tombstone that completion retries cannot regenerate", () => {
  const first = planCompletionBillingReview(base);
  const reviews = first.reviews.map(row => ({ ...row, reviewState: "discarded", reviewRevision: 2 }));
  const result = planCompletionBillingReview({ ...base, reviews });
  assert.equal(result.changed, false);
  assert.equal(result.outcome.status, "discarded");
  assert.deepEqual(result.reviews, reviews);
});

test("reopen tombstone permits a later new completion receipt, without reusing old source evidence", () => {
  const first = planCompletionBillingReview(base);
  const reversed = planCompletionBillingReview({ ...base, reviews: first.reviews, mode: "reverse" });
  assert.equal(reversed.reviews[0].reviewState, "discarded");
  const second = planCompletionBillingReview({ ...base, reviews: reversed.reviews, receiptId: "receipt-2", completed: { "repair-1": { receiptId: "receipt-2" } }, entry: { invoice: "$150", completionReceiptId: "receipt-2" } });
  assert.equal(second.reviews.length, 1);
  assert.equal(second.reviews[0].reviewState, "pending");
  assert.equal(second.reviews[0].sourceCompletionReceiptId, "receipt-2");
  assert.equal(second.reviews[0].lineItems[0].unitPrice, "150");
});

test("completion and reopening preserve real issued invoices even when they resemble old auto-drafts", () => {
  const invoice = { ...planCompletionBillingReview(base).reviews[0], number: "INV-100", status: "Draft", qbId: "10" };
  delete invoice.recordType;
  for (const mode of ["complete", "reverse"]) {
    const result = planCompletionBillingReview({ ...base, mode, invoices: [invoice] });
    assert.deepEqual(result.invoices, [invoice]);
    assert.equal(result.reviews.length, 0);
    assert.equal(result.changed, false);
  }
});

test("legacy accounting claims fence completed source work before its invoice projection arrives", () => {
  const claim = { id: "manual-invoice-1", recordType: "invoice-number-claim", clientId: "c1", reviewState: "synced", sourceStopId: "repair-1", sourceCompletionReceiptId: "receipt-1", approval: { number: "INV-123" } };
  for (const mode of ["complete", "reverse"]) {
    const result = planCompletionBillingReview({ ...base, reviews: [claim], mode });
    assert.equal(result.changed, false);
    assert.deepEqual(result.reviews, [claim]);
    assert.equal(result.billingReview, null);
    assert.equal(result.outcome.billingReviewId, undefined);
  }
  const invoice = { id: claim.id, clientId: claim.clientId, number: "INV-123", sourceStopId: claim.sourceStopId, status: "Draft" };
  const withProjection = planCompletionBillingReview({ ...base, invoices: [invoice], reviews: [claim] });
  assert.equal(withProjection.changed, false);
  assert.deepEqual(withProjection.reviews, [claim]);
  const editedProjection = { ...invoice }; delete editedProjection.sourceStopId;
  assert.equal(planCompletionBillingReview({ ...base, invoices: [editedProjection], reviews: [claim] }).changed, false, "An edited projection cannot release a durable source claim.");
  assert.deepEqual(collectBillingReviewNumberClaims({ reviews: [claim] }), ["INV-123"]);
  const numberOnly = { id: "legacy-qb-1", recordType: "invoice-number-claim", reviewState: "synced", numberClaims: ["INV-122"], approval: { number: "INV-123" } };
  assert.deepEqual(collectBillingReviewNumberClaims({ reviews: [numberOnly] }), ["INV-123", "INV-122"]);
  assert.equal(planCompletionBillingReview({ ...base, reviews: [numberOnly] }).reviews.length, 2);
});

test("completion fences a differently named invoice with line-level visit provenance", () => {
  const invoice = { id: "manual", clientId: "c1", status: "Paid", lineItems: [{ sourceCompletionReceiptId: "receipt-1", unitPrice: "125" }] };
  const result = planCompletionBillingReview({ ...base, invoices: [invoice] });
  assert.equal(result.changed, false);
  assert.equal(result.outcome.reason, "source-already-linked");
  assert.deepEqual(result.outcome.invoiceIds, ["manual"]);
  assert.deepEqual(result.reviews, []);
});

test("monthly completion cannot include an individual visit already billed outside that monthly ID", () => {
  const first = { sid: "monthly-first", clientId: "c1", type: "Pond maintenance", frequency: "Weekly" };
  const last = { ...first, sid: "monthly-last" };
  const entry = { invoice: "$100", completionReceiptId: "receipt-last" };
  const result = planCompletionBillingReview({ ...base, stop: last, entry, receiptId: "receipt-last",
    client: { ...client, autoInvoice: "Monthly", monthlyRate: "450", history: [{ sid: first.sid, completionReceiptId: "receipt-first", invoice: "$100" }] },
    schedule: [{ date: "10/01/2026", stops: [first] }, { date: "10/08/2026", stops: [last] }],
    completed: { [first.sid]: { receiptId: "receipt-first" }, [last.sid]: { receiptId: "receipt-last" } },
    invoices: [{ id: "manual-first", clientId: "c1", sourceStopIds: [first.sid], status: "Paid" }],
  });
  assert.equal(result.changed, false);
  assert.equal(result.outcome.reason, "source-already-linked");
  assert.deepEqual(result.reviews, []);
});

test("prepaid maintenance omits the paid service and retains billable extras in review", () => {
  const recurring = { sid: "repair-1", clientId: "c1", type: "Pond maintenance", frequency: "Weekly" };
  const result = planCompletionBillingReview({ ...base, stop: recurring, schedule: [{ date: "10/05/2026", stops: [recurring] }], maintenanceBillingDecision: { covered: true, snapshot: { mode: "prepaid" } }, entry: { ...base.entry, services: [{ name: "Pond maintenance", price: 125 }], productsPurchased: [{ id: "p1", name: "Filter pad", qty: 1, price: 20, bill: true }] } });
  assert.deepEqual(result.reviews[0].lineItems.map(row => row.desc), ["Filter pad"]);
  assert.equal(result.reviews[0].number, "");
});

test("estimate completion uses frozen quote scope and never rebills quoted materials", () => {
  const estimateStop = { ...stop, source: "estimate", sourceEstimateId: "est-1", estimateTaxEnabled: true, estimateTaxRate: "6", estimateItems: [
    { id: "labor", description: "Install", quantity: "1", unitPrice: "300", taxable: false, kind: "custom" },
    { id: "pump", description: "Pump", quantity: "1", unitPrice: "200", taxable: true, kind: "product", refId: "p1" },
  ], plannedMaterials: [{ kind: "product", refId: "p1", quantity: "1" }] };
  const result = planCompletionBillingReview({ ...base, stop: estimateStop, entry: { ...base.entry, invoice: "$9999", productsPurchased: [{ id: "p1", qty: 1, name: "Pump", price: 200, bill: true }] } });
  assert.equal(result.reviews[0].id, "iv_est_est-1");
  assert.deepEqual(result.reviews[0].lineItems.map(row => [row.desc, row.unitPrice]), [["Install", "300"], ["Pump", "200"]]);
  assert.equal(result.reviews[0].taxRate, "6");
  assert.equal(result.reviews[0].number, "");
});

test("migration moves only never-issued source drafts and atomically changes estimate and schedule backlinks", () => {
  const draft = { id: "iv_est_e1", number: "INV-100", status: "Draft", clientId: "c1", source: "estimate", sourceEstimateId: "e1", lineItems: [{ desc: "Work", qty: "1", unitPrice: "200" }] };
  const protectedRows = [
    { ...draft, id: "qb", sourceEstimateId: "qb-source", qbId: "50" }, { ...draft, id: "sent", sourceEstimateId: "sent-source", sentAt: "2026-10-01" },
    { ...draft, id: "shared", sourceEstimateId: "shared-source", sharedAt: "2026-10-01" }, { ...draft, id: "paid", sourceEstimateId: "paid-source", status: "Paid" },
    { id: "manual", number: "INV-101", status: "Draft", clientId: "c1" },
  ];
  const input = { invoices: [draft, ...protectedRows], reviews: [], estimates: [{ id: "e1", clientId: "c1", linkedInvoiceId: draft.id, linkedInvoiceNumber: draft.number }], schedule: [{ date: "10/05/2026", stops: [{ ...stop, linkedInvoiceId: draft.id, sourceEstimateId: "e1", estimateFulfillment: { billingDisposition: "linked-invoice" } }] }], now };
  const before = structuredClone(input);
  const result = planBillingReviewMigration(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.invoices, protectedRows);
  assert.deepEqual(result.migratedIds, [draft.id]);
  assert.deepEqual(result.reviews[0].billingReviewAudit.originalInvoice, draft);
  assert.equal(result.reviews[0].number, "");
  assert.equal(result.estimates[0].linkedInvoiceId, undefined);
  assert.equal(result.estimates[0].linkedBillingReviewId, draft.id);
  assert.equal(result.schedule[0].stops[0].estimateFulfillment.billingDisposition, "billing-review");
  const retry = planBillingReviewMigration({ ...result, now });
  assert.equal(retry.changed, false);
});

test("migration never replaces an existing review or crosses a conflicting client backlink", () => {
  const draft = { id: "i1", clientId: "c1", number: "INV-12", status: "Draft", sourceStopId: "s1" };
  const review = { ...makeBillingReview(draft, { now }), reviewState: "discarded" };
  assert.equal(planBillingReviewMigration({ invoices: [draft], reviews: [review] }).changed, false);
  assert.equal(planBillingReviewMigration({ invoices: [draft], estimates: [{ id: "e1", clientId: "other", linkedInvoiceId: "i1" }] }).changed, false);
  const remote = planBillingReviewMigration({ invoices: [draft], protectedNumbers: new Set(["INV-12"]) });
  assert.equal(remote.changed, false);
  assert.equal(remote.skipped[0].reason, "quickbooks-number-present");
  for (const protectedNumber of ["12", "00012", "old-12"]) {
    const equivalent = planBillingReviewMigration({ invoices: [draft], protectedNumbers: [protectedNumber] });
    assert.equal(equivalent.changed, false, protectedNumber);
    assert.equal(equivalent.skipped[0].reason, "quickbooks-number-present", protectedNumber);
    assert.deepEqual(equivalent.invoices, [draft]);
    assert.deepEqual(equivalent.reviews, []);
  }
  assert.equal(planBillingReviewMigration({ invoices: [draft], protectedNumbers: ["13"] }).changed, true);
  const duplicateSource = planBillingReviewMigration({ invoices: [draft, { id: "real", status: "Paid", lineItems: [{ sourceStopId: "s1" }] }] });
  assert.equal(duplicateSource.changed, false);
  assert.equal(duplicateSource.skipped[0].reason, "source-already-linked");
});

test("number claims exclude migrated never-issued audit numbers but retain approvals and actual invoices", () => {
  const review = makeBillingReview({ id: "r1", clientId: "c1", number: "INV-10" }, { now, originalInvoice: { number: "INV-10" } });
  assert.deepEqual(collectBillingReviewNumberClaims({ invoices: [{ number: "INV-11" }], reviews: [review, { approval: { number: "INV-12" }, reviewState: "approving" }] }), ["INV-11", "INV-12"]);
});

test("migration protects payment allocations and prepaid policy references even without QuickBooks metadata", () => {
  const draft = { id: "i1", clientId: "c1", number: "INV-12", status: "Draft", sourceStopId: "s1" };
  for (const status of ["paid", "partial", "prepaid", "review", "waived", "refunded"]) {
    const ledger = { version: 2, policies: {}, allocations: { c1: { "2026-10": { status, sources: [{ kind: "invoice", invoiceId: "i1" }] } } } };
    const result = planBillingReviewMigration({ invoices: [draft], ledger });
    assert.equal(result.changed, false, status);
    assert.equal(result.skipped[0].reason, "payment-coverage", status);
    assert.equal(result.ledgerChanged, false, status);
    assert.deepEqual(result.ledger, ledger);
  }
  const policy = { version: 1, mode: "prepaid", coveredFrom: "2026-04-01", coveredThrough: "2026-10-31", sourceInvoiceNumber: "INV-12" };
  assert.equal(planBillingReviewMigration({ invoices: [draft], ledger: { version: 2, policies: { c1: policy }, allocations: {} } }).skipped[0].reason, "payment-coverage");
  assert.equal(planBillingReviewMigration({ invoices: [draft], clientPolicies: { c1: { ...policy, sourceInvoiceNumber: "", sourceInvoiceId: "i1" } } }).skipped[0].reason, "payment-coverage");
  assert.throws(() => planBillingReviewMigration({ invoices: [draft], ledger: null }), /verified payment coverage/);
});

test("migration detaches only unpaid invoice coverage and preserves unrelated sources atomically", () => {
  const draft = { id: "i1", clientId: "c1", number: "INV-12", status: "Draft", sourceStopId: "s1" };
  const other = { kind: "invoice", invoiceId: "i2", amountCents: 2500 };
  const ledger = { version: 2, policies: {}, allocations: { c1: {
    "2026-09": { status: "due", sources: [{ kind: "invoice", invoiceNumber: "INV-12", amountCents: 10000 }] },
    "2026-10": { status: "due", sources: [{ kind: "invoice", invoiceId: "i1", amountCents: 10000 }, other], allocatedCents: 12500 },
  } } };
  const original = structuredClone(ledger);
  const result = planBillingReviewMigration({ invoices: [draft], ledger });
  assert.deepEqual(result.migratedIds, ["i1"]);
  assert.equal(result.ledgerChanged, true);
  assert.equal(result.ledger.allocations.c1["2026-09"], undefined);
  assert.deepEqual(result.ledger.allocations.c1["2026-10"], { status: "due", sources: [other], allocatedCents: 2500 });
  assert.deepEqual(ledger, original);
});

test("estimate preparation remains unnumbered and enforces legacy tax confirmation", () => {
  const estimate = { id: "e1", number: "EST-10", status: "approved", items: [{ id: "l1", desc: "Labor", kind: "service", price: "100", qty: "1" }], taxEnabled: true, taxRate: "6" };
  assert.throws(() => prepareEstimateBillingReview({ estimate, client, now }), { code: "estimate-tax-confirmation-required" });
  const review = prepareEstimateBillingReview({ estimate, client, now, taxMigrationConfirmed: true });
  assert.equal(review.number, "");
  assert.equal(review.sourceEstimateId, "e1");
  assert.equal(review.lineItems[0].taxable, false);
});

test("review-mode completion records quoted history and inventory without writing customer debt", () => {
  const result = applyStopCompletion({ clients: [client], catalog: { locations: [], products: [], parts: [], treatments: [] }, completed: {}, clientId: "c1", entry: { invoice: "$125" }, sid: stop.sid, receiptId: "receipt-1", idempotencyKey: "review-completion-1", completedAt: new Date(now).toISOString(), postBalance: false });
  assert.equal(result.ok, true);
  assert.equal(result.clients[0].balance, "$25");
  assert.equal(result.clients[0].history[0].invoice, "$125");
  assert.equal(result.receipt.balance.changed, false);
});
