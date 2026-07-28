const asText = (value) => String(value == null ? "" : value).trim();

const normalizedStatus = (invoice, effectiveStatus) => (
  asText(effectiveStatus || invoice?.status).toLowerCase()
);

/**
 * Keep the review gate in one place so the banner count, review sheet, and
 * accounting exclusion cannot drift apart.
 */
export function invoiceNeedsReconciliationReview(invoice, options = {}) {
  if (!invoice || typeof invoice !== "object") return false;
  if (invoice.qbSpsOnly === true || invoice.qbSyncStatus === "sps-only") return false;
  const balance = Number(options.balance);
  const remainingBalance = Number.isFinite(balance)
    ? balance
    : Number(invoice.balance ?? invoice.total ?? 0);
  const status = normalizedStatus(invoice, options.effectiveStatus);

  return (
    invoice.qbNeedsReview === true
    || invoice.qbSyncStatus === "missing-remote"
    || (
      !asText(invoice.qbId)
      && !["paid", "draft", "void"].includes(status)
      && remainingBalance > 0
    )
  );
}

/**
 * Explain why one invoice is in the queue and which existing, explicit user
 * flow can resolve it. This helper is deliberately descriptive only: it never
 * edits an SPS record or calls QuickBooks.
 */
export function invoiceReconciliationIssue(invoice, options = {}) {
  const qbId = asText(invoice?.qbId);
  const syncStatus = asText(invoice?.qbSyncStatus);
  const conflictReason = asText(invoice?.qbSyncConflict?.reason);
  const relatedInvoiceId = asText(invoice?.qbDuplicateOfId);
  const diagnostics = {
    lastError: asText(invoice?.qbSyncError),
    errorCode: asText(invoice?.qbSyncErrorCode),
    attemptedAt: asText(invoice?.qbSyncAttemptedAt),
  };

  if (syncStatus === "duplicate-local-qb-id") {
    return {
      code: "duplicate-local-qb-id",
      title: "Two SPS records share one QuickBooks invoice",
      reason: qbId
        ? `This record and another SPS record both point to QuickBooks invoice ${qbId}. Neither record was deleted.`
        : "This record duplicates another SPS-to-QuickBooks link. Neither record was deleted.",
      nextStep: "Compare both SPS records before deciding which one should keep the QuickBooks link.",
      actionLabel: "Open this record",
      relatedActionLabel: relatedInvoiceId ? "View preferred record" : "",
      relatedInvoiceId,
      qbId,
      ...diagnostics,
    };
  }

  if (syncStatus === "missing-remote") {
    return {
      code: "missing-remote",
      title: "Not found in the latest QuickBooks snapshot",
      reason: qbId
        ? `SPS still has this invoice, but QuickBooks did not return invoice ID ${qbId} during a complete sync. SPS kept the record instead of deleting it.`
        : "SPS still has this invoice, but its linked QuickBooks record was not returned during a complete sync.",
      nextStep: "Confirm the invoice in QuickBooks, then open this record to review or deliberately recreate it.",
      actionLabel: "Review invoice",
      relatedActionLabel: "",
      relatedInvoiceId: "",
      qbId,
      ...diagnostics,
    };
  }

  if (syncStatus === "conflict" || !!invoice?.qbPendingRemoteInvoice) {
    const recoveredCreate = conflictReason === "newer-local-edits-after-unknown-create";
    return {
      code: "conflict",
      title: recoveredCreate
        ? "QuickBooks recovered an earlier version"
        : "SPS and QuickBooks both changed",
      reason: recoveredCreate
        ? "QuickBooks recovered the original create request after SPS received newer edits. SPS stopped before replacing either version."
        : "SPS stopped the sync before replacing local or QuickBooks lines because both versions may contain changes.",
      nextStep: "Open the invoice and explicitly choose the QuickBooks version or the SPS version.",
      actionLabel: "Compare versions",
      relatedActionLabel: "",
      relatedInvoiceId: "",
      qbId,
      ...diagnostics,
    };
  }

  if (diagnostics.lastError) {
    return {
      code: syncStatus || "sync-failed",
      title: "QuickBooks sync did not complete",
      reason: "SPS saved the invoice locally and kept the failed QuickBooks attempt visible instead of claiming it synced.",
      nextStep: qbId
        ? "Open the invoice, review the saved error, and retry only after the QuickBooks issue is corrected."
        : "Open the invoice, review the saved error, and retry its QuickBooks link when ready.",
      actionLabel: qbId ? "Review failed sync" : "Retry invoice link",
      relatedActionLabel: "",
      relatedInvoiceId: "",
      qbId,
      ...diagnostics,
    };
  }

  if (!qbId) {
    return {
      code: "not-linked",
      title: "Open SPS invoice is not linked to QuickBooks",
      reason: "This non-draft SPS invoice has a remaining balance but no QuickBooks invoice ID, so it is excluded from QuickBooks totals.",
      nextStep: "Open the invoice and save it to create or recover its QuickBooks link.",
      actionLabel: "Link invoice",
      relatedActionLabel: "",
      relatedInvoiceId: "",
      qbId: "",
      ...diagnostics,
    };
  }

  return {
    code: syncStatus || "review",
    title: "Invoice needs reconciliation review",
    reason: "SPS kept this invoice out of the QuickBooks accounting total because its link could not be confirmed safely.",
    nextStep: "Open the invoice and compare it with QuickBooks before making a change.",
    actionLabel: "Review invoice",
    relatedActionLabel: "",
    relatedInvoiceId: "",
    qbId,
    ...diagnostics,
  };
}
