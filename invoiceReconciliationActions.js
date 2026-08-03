import { reconcileQuickBooksInvoice } from "./quickbooksInvoiceReconciliation.js";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const text = (value) => String(value == null ? "" : value).trim();
const normalizedText = (value) => text(value).replace(/\s+/g, " ").toLowerCase();
const cents = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
};

const customerMatches = (localInvoice, quickBooksInvoice) => {
  const localCustomerId = text(localInvoice?.qbCustomerId);
  const remoteCustomerId = text(quickBooksInvoice?.qbCustomerId);
  if (localCustomerId && remoteCustomerId) return localCustomerId === remoteCustomerId;

  const localName = normalizedText(localInvoice?.clientName);
  const remoteName = normalizedText(quickBooksInvoice?.clientName);
  return !!(localName && remoteName && localName === remoteName);
};

/**
 * Describe whether a QuickBooks invoice is a safe candidate for an SPS record.
 *
 * A shared document number is not enough: QuickBooks can reuse numbers after a
 * void/import and two customers can have similarly named work. An unlinked
 * record is safe to attach only when number, customer and total all match.
 */
export function assessQuickBooksInvoiceMatch(localInvoice, quickBooksInvoice) {
  const localQbId = text(localInvoice?.qbId);
  const remoteQbId = text(quickBooksInvoice?.qbId);
  const exactId = !!(localQbId && remoteQbId && localQbId === remoteQbId);
  const numberMatch = !!(
    text(localInvoice?.number)
    && text(quickBooksInvoice?.number)
    && normalizedText(localInvoice.number) === normalizedText(quickBooksInvoice.number)
  );
  const customerMatch = customerMatches(localInvoice, quickBooksInvoice);
  const localTotal = cents(localInvoice?.total);
  const remoteTotal = cents(quickBooksInvoice?.total);
  const totalMatch = localTotal != null && remoteTotal != null && localTotal === remoteTotal;

  const evidence = [
    ...(exactId ? ["quickbooks-id"] : []),
    ...(numberMatch ? ["document-number"] : []),
    ...(customerMatch ? ["customer"] : []),
    ...(totalMatch ? ["total"] : []),
  ];
  const strictContentMatch = numberMatch && customerMatch && totalMatch;

  return {
    qbId: remoteQbId,
    exactId,
    numberMatch,
    customerMatch,
    totalMatch,
    evidence,
    // A known identical QB id is authoritative even if QuickBooks changed its
    // balance or lines. A replacement id requires all three content anchors.
    eligible: !!remoteQbId && (exactId || strictContentMatch),
    confidence: exactId ? "linked-id" : (strictContentMatch ? "strict-content" : "insufficient"),
  };
}

export function rankQuickBooksInvoiceCandidates(localInvoice, candidates) {
  const assessed = (Array.isArray(candidates) ? candidates : []).map((invoice) => ({
    invoice,
    assessment: assessQuickBooksInvoiceMatch(localInvoice, invoice),
  }));
  const eligible = assessed.filter((entry) => entry.assessment.eligible);
  const exactId = eligible.filter((entry) => entry.assessment.exactId);
  const strict = eligible.filter((entry) => entry.assessment.confidence === "strict-content");
  const winner = exactId.length === 1
    ? exactId[0]
    : (exactId.length === 0 && strict.length === 1 ? strict[0] : null);

  return {
    candidates: assessed.map((entry) => ({
      ...entry,
      safeToLink: entry === winner,
    })),
    safeCandidate: winner?.invoice || null,
    ambiguous: !winner && eligible.length > 0,
  };
}

const clearReviewFields = (invoice) => {
  const next = { ...invoice };
  for (const field of [
    "qbNeedsReview",
    "qbRemoteChangesPending",
    "qbSyncConflict",
    "qbPendingRemoteInvoice",
    "qbDuplicateOfId",
    "qbMissingSince",
  ]) delete next[field];
  return next;
};

/**
 * Resolve an invoice review only after an explicit owner choice.
 *
 * This helper is pure and performs no network/database writes. Callers persist
 * the returned record through the existing versioned app-state path.
 */
export function resolveInvoiceReconciliationReview(localInvoice, options = {}) {
  if (!localInvoice || typeof localInvoice !== "object" || Array.isArray(localInvoice)) {
    throw new TypeError("A local SPS invoice is required.");
  }
  const action = text(options.action);
  const resolvedAt = text(options.resolvedAt) || new Date().toISOString();

  if (action === "retry-linked" || action === "match-remote") {
    const remote = options.quickBooksInvoice;
    if (!remote || typeof remote !== "object" || !Array.isArray(remote.lineItems)) {
      throw new TypeError("A complete QuickBooks invoice snapshot is required.");
    }
    const assessment = assessQuickBooksInvoiceMatch(localInvoice, remote);
    if (!assessment.eligible) {
      const error = new Error("QuickBooks candidate does not match the SPS invoice by id or by number, customer, and total.");
      error.code = "QB_REVIEW_MATCH_UNSAFE";
      throw error;
    }
    if (
      action === "match-remote"
      && !assessment.exactId
      && Number(options.eligibleCandidateCount) !== 1
    ) {
      const error = new Error("QuickBooks match is ambiguous. Choose a unique exact customer, number, and total match.");
      error.code = "QB_REVIEW_MATCH_AMBIGUOUS";
      throw error;
    }

    const previousQbId = text(localInvoice.qbId);
    const prepared = clearReviewFields({
      ...localInvoice,
      qbId: remote.qbId,
      // Reaching this branch requires an explicit owner choice to adopt the
      // confirmed QuickBooks snapshot. Clear every local accounting-edit fence
      // before reconciling; otherwise a failed pending push immediately turns
      // back into a conflict and the "Use QuickBooks" action appears to do
      // nothing. The reconciler still preserves SPS-only line metadata such as
      // costs, catalog references, and estimate/visit provenance.
      locallyEdited: false,
      qbPendingLocalEdits: false,
      qbLocalChangesPending: false,
      qbSyncStatus: "synced",
    });
    const reconciled = reconcileQuickBooksInvoice(prepared, remote);
    const next = {
      ...reconciled,
      qbAccountingExcluded: false,
      qbSpsOnly: false,
      qbReviewResolution: {
        action: assessment.exactId ? "retry-linked" : "match-remote",
        resolvedAt,
        qbId: text(remote.qbId),
        evidence: assessment.evidence,
      },
    };
    if (previousQbId && previousQbId !== text(remote.qbId)) {
      next.qbFormerId = previousQbId;
    }
    return next;
  }

  if (action === "keep-sps-only") {
    const status = text(localInvoice.qbSyncStatus);
    const hasLiveConflict = status === "conflict" || !!localInvoice.qbPendingRemoteInvoice;
    if (hasLiveConflict) {
      const error = new Error("A live QuickBooks conflict cannot be dismissed as SPS-only. Choose the SPS or QuickBooks version first.");
      error.code = "QB_REVIEW_LIVE_CONFLICT";
      throw error;
    }
    if (options.acknowledged !== true) {
      const error = new Error("Keeping an invoice SPS-only requires explicit acknowledgement.");
      error.code = "QB_REVIEW_ACK_REQUIRED";
      throw error;
    }

    const previousQbId = text(localInvoice.qbId);
    const next = clearReviewFields({
      ...localInvoice,
      qbId: null,
      qbSyncStatus: "sps-only",
      qbSpsOnly: true,
      qbAccountingExcluded: true,
      qbAuthoritative: false,
      qbPushed: false,
      locallyEdited: false,
      qbPendingLocalEdits: false,
      qbLocalChangesPending: false,
      qbReviewResolution: {
        action: "keep-sps-only",
        resolvedAt,
        ...(previousQbId ? { formerQbId: previousQbId } : {}),
      },
    });
    if (previousQbId) next.qbFormerId = previousQbId;
    for (const field of [
      "qbSyncToken",
      "qbLastUpdatedTime",
      "qbContentFingerprint",
      "qbBaseContentFingerprint",
      "qbTaxCodeRef",
    ]) {
      if (own(next, field)) delete next[field];
    }
    delete next.qbSyncError;
    delete next.qbSyncErrorCode;
    delete next.qbSyncAttemptedAt;
    return next;
  }

  throw new TypeError("Unknown invoice reconciliation action.");
}
