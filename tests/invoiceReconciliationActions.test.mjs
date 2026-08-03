import assert from "node:assert/strict";
import test from "node:test";

import {
  assessQuickBooksInvoiceMatch,
  rankQuickBooksInvoiceCandidates,
  resolveInvoiceReconciliationReview,
} from "../invoiceReconciliationActions.js";

const localInvoice = (overrides = {}) => ({
  id: "local-1963",
  qbId: "old-1963",
  qbCustomerId: "customer-7",
  number: "1963",
  clientName: "Generic Client",
  total: 206.55,
  balance: 206.55,
  status: "Sent",
  qbNeedsReview: true,
  qbSyncStatus: "missing-remote",
  lineItems: [{
    id: "local-line",
    desc: "Service visit",
    qty: "1",
    unitPrice: "206.55",
    taxable: false,
    unitCost: "35",
    costKnown: true,
  }],
  ...overrides,
});

const remoteInvoice = (overrides = {}) => ({
  qbId: "qb-1963",
  qbCustomerId: "customer-7",
  qbSyncToken: "4",
  qbContentFingerprint: "fingerprint-4",
  number: "1963",
  clientName: "Generic Client",
  total: 206.55,
  balance: 206.55,
  status: "Sent",
  lineItems: [{
    id: "qbl_qb-1963_1",
    qbLineId: "1",
    desc: "Service visit",
    qty: "1",
    unitPrice: "206.55",
    taxable: false,
    kind: "service",
  }],
  ...overrides,
});

test("replacement matching requires document number, customer and exact cents", () => {
  const exact = assessQuickBooksInvoiceMatch(localInvoice(), remoteInvoice());
  assert.equal(exact.eligible, true);
  assert.equal(exact.confidence, "strict-content");

  assert.equal(assessQuickBooksInvoiceMatch(
    localInvoice(),
    remoteInvoice({ total: 206.54 }),
  ).eligible, false);
  assert.equal(assessQuickBooksInvoiceMatch(
    localInvoice(),
    remoteInvoice({ qbCustomerId: "different-customer" }),
  ).eligible, false);
  assert.equal(assessQuickBooksInvoiceMatch(
    localInvoice(),
    remoteInvoice({ number: "1964" }),
  ).eligible, false);
});

test("known QuickBooks id remains authoritative when accounting values changed", () => {
  const assessment = assessQuickBooksInvoiceMatch(
    localInvoice({ qbId: "qb-1963" }),
    remoteInvoice({ total: 250, balance: 150 }),
  );
  assert.equal(assessment.eligible, true);
  assert.equal(assessment.exactId, true);
  assert.equal(assessment.confidence, "linked-id");
});

test("candidate ranking never auto-selects ambiguous strict matches", () => {
  const first = remoteInvoice({ qbId: "candidate-1" });
  const second = remoteInvoice({ qbId: "candidate-2" });
  const ranked = rankQuickBooksInvoiceCandidates(localInvoice(), [first, second]);

  assert.equal(ranked.safeCandidate, null);
  assert.equal(ranked.ambiguous, true);
  assert.equal(ranked.candidates.every((entry) => entry.safeToLink === false), true);
});

test("an explicit unique strict match rebinds the missing id and adopts QuickBooks", () => {
  const result = resolveInvoiceReconciliationReview(localInvoice(), {
    action: "match-remote",
    quickBooksInvoice: remoteInvoice(),
    eligibleCandidateCount: 1,
    resolvedAt: "2026-07-28T16:00:00.000Z",
  });

  assert.equal(result.qbId, "qb-1963");
  assert.equal(result.qbFormerId, "old-1963");
  assert.equal(result.qbSyncStatus, "synced");
  assert.equal(result.qbAuthoritative, true);
  assert.equal(result.qbNeedsReview, undefined);
  assert.equal(result.lineItems[0].id, "local-line");
  assert.equal(result.lineItems[0].unitCost, "35");
  assert.deepEqual(result.qbReviewResolution, {
    action: "match-remote",
    resolvedAt: "2026-07-28T16:00:00.000Z",
    qbId: "qb-1963",
    evidence: ["document-number", "customer", "total"],
  });
});

test("explicitly using a confirmed QuickBooks record resolves a failed-push conflict", () => {
  const quickBooksVersion = remoteInvoice({
    total: 225,
    balance: 125,
    qbHasUnsupportedLines: true,
    qbUnsupportedLineTypes: ["DescriptionOnly"],
    lineItems: [{
      id: "qbl_qb-1963_1",
      qbLineId: "1",
      desc: "Service visit",
      qty: "1",
      unitPrice: "225",
      taxable: false,
      kind: "service",
    }],
  });
  const result = resolveInvoiceReconciliationReview(localInvoice({
    qbId: "qb-1963",
    qbSyncStatus: "conflict",
    locallyEdited: true,
    qbPendingLocalEdits: true,
    qbLocalChangesPending: true,
    qbRemoteChangesPending: true,
    qbPendingRemoteInvoice: quickBooksVersion,
    qbSyncConflict: {
      type: "quickbooks-remote-update",
      reason: "pending-local-edits",
      qbId: "qb-1963",
    },
    qbSyncError: "The previous update could not reach QuickBooks.",
    qbSyncErrorCode: "QB_NETWORK_ERROR",
    qbSyncAttemptedAt: "2026-07-28T16:00:00.000Z",
    lineItems: [{
      id: "local-line",
      desc: "Service visit",
      qty: "1",
      unitPrice: "206.55",
      taxable: false,
      unitCost: "35",
      costKnown: true,
      refId: "service-7",
      chargeType: "labor",
      chargeLabel: "Labor & services",
      sourceEstimateLineId: "estimate-line-4",
      sourceVisitLineId: "visit-line-9",
    }],
  }), {
    action: "retry-linked",
    quickBooksInvoice: quickBooksVersion,
    resolvedAt: "2026-07-28T16:05:00.000Z",
  });

  assert.equal(result.qbSyncStatus, "synced");
  assert.equal(result.qbAuthoritative, true);
  assert.equal(result.qbNeedsReview, undefined);
  assert.equal(result.qbRemoteChangesPending, undefined);
  assert.equal(result.qbPendingRemoteInvoice, undefined);
  assert.equal(result.qbSyncConflict, undefined);
  assert.equal(result.locallyEdited, false);
  assert.equal(result.qbPendingLocalEdits, undefined);
  assert.equal(result.qbLocalChangesPending, undefined);
  assert.equal(result.qbSyncError, undefined);
  assert.equal(result.total, 225);
  assert.equal(result.balance, 125);
  assert.equal(result.qbHasUnsupportedLines, true);
  assert.deepEqual(result.qbUnsupportedLineTypes, ["DescriptionOnly"]);
  assert.deepEqual(result.lineItems[0], {
    id: "local-line",
    qbLineId: "1",
    desc: "Service visit",
    qty: "1",
    unitPrice: "225",
    taxable: false,
    kind: "service",
    unitCost: "35",
    costKnown: true,
    refId: "service-7",
    chargeType: "labor",
    chargeLabel: "Labor & services",
    sourceEstimateLineId: "estimate-line-4",
    sourceVisitLineId: "visit-line-9",
  });
  assert.deepEqual(result.qbReviewResolution, {
    action: "retry-linked",
    resolvedAt: "2026-07-28T16:05:00.000Z",
    qbId: "qb-1963",
    evidence: ["quickbooks-id", "document-number", "customer"],
  });
});

test("matching rejects mismatched or ambiguous candidates without changing local data", () => {
  assert.throws(() => resolveInvoiceReconciliationReview(localInvoice(), {
    action: "match-remote",
    quickBooksInvoice: remoteInvoice({ total: 999 }),
    eligibleCandidateCount: 1,
  }), (error) => error.code === "QB_REVIEW_MATCH_UNSAFE");

  assert.throws(() => resolveInvoiceReconciliationReview(localInvoice(), {
    action: "match-remote",
    quickBooksInvoice: remoteInvoice(),
    eligibleCandidateCount: 2,
  }), (error) => error.code === "QB_REVIEW_MATCH_AMBIGUOUS");
});

test("keeping a missing invoice SPS-only is explicit, auditable and prevents stale relinking", () => {
  const result = resolveInvoiceReconciliationReview(localInvoice({
    qbSyncError: "Previous retry failed",
    qbSyncErrorCode: "QB_SYNC_FAILED",
    qbSyncAttemptedAt: "2026-07-28T16:09:00.000Z",
  }), {
    action: "keep-sps-only",
    acknowledged: true,
    resolvedAt: "2026-07-28T16:10:00.000Z",
  });

  assert.equal(result.qbId, null);
  assert.equal(result.qbFormerId, "old-1963");
  assert.equal(result.qbSyncStatus, "sps-only");
  assert.equal(result.qbSpsOnly, true);
  assert.equal(result.qbAccountingExcluded, true);
  assert.equal(result.qbNeedsReview, undefined);
  assert.equal(result.qbSyncError, undefined);
  assert.deepEqual(result.qbReviewResolution, {
    action: "keep-sps-only",
    resolvedAt: "2026-07-28T16:10:00.000Z",
    formerQbId: "old-1963",
  });
});

test("SPS-only resolution cannot dismiss a live QuickBooks conflict", () => {
  assert.throws(() => resolveInvoiceReconciliationReview(localInvoice({
    qbSyncStatus: "conflict",
    qbPendingRemoteInvoice: remoteInvoice(),
  }), {
    action: "keep-sps-only",
    acknowledged: true,
  }), (error) => error.code === "QB_REVIEW_LIVE_CONFLICT");
});
