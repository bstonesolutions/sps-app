import { buildQuickBooksInvoicePayload, quickBooksDraftSyncEligibility } from "./quickbooksDraftSync.js";
import { applyQuickBooksInvoiceSaveResult, applyQuickBooksInvoiceSyncFailure, quickBooksInvoiceIntentSignature } from "./quickbooksInvoiceReconciliation.js";

const text = (value) => String(value ?? "").trim();
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};

export function quickBooksInvoiceSyncEligibility(invoice, client) {
  if (!["draft", "sent", "overdue"].includes(text(invoice?.status).toLowerCase()) || invoice?.payment || invoice?.partial || invoice?.payments?.length || invoice?.paidDate || invoice?.paidAt) {
    return { eligible: false, reason: "Review payments or invoice status in the editor" };
  }
  if (invoice?.qbNeedsReview || invoice?.qbReviewRequired || invoice?.qbConflict || invoice?.qbRemoteChangesPending || invoice?.qbPendingRemote || invoice?.qbPendingRemoteInvoice || invoice?.qbDuplicate || invoice?.qbSyncConflict) {
    return { eligible: false, reason: "Review the QuickBooks changes in the editor" };
  }
  if (invoice?.qbAccountingExcluded) return { eligible: false, reason: "Excluded from QuickBooks accounting" };
  if (invoice?.qbId) {
    if (!text(invoice.qbBaseContentFingerprint || invoice.qbContentFingerprint)) {
      return { eligible: false, reason: "Refresh from QuickBooks before syncing changes" };
    }
    // Reuse the established draft validation while allowing an identified,
    // revision-checked QuickBooks twin to be updated through this action.
    const validationCopy = { ...invoice, status: "Draft" };
    ["qbId", "qbPushed", "qbAuthoritative", "qbSyncToken", "qbSyncStatus", "qbPendingRemote", "qbDuplicate", "source", "origin"].forEach((key) => { delete validationCopy[key]; });
    if (invoice.qbSpsOnly || invoice.qbSyncStatus === "sps-only") return { eligible: false, reason: "Marked SPS-only" };
    if (invoice.qbCreateOutcomeUnknown || ["create-outcome-unknown", "local-save-unconfirmed"].includes(invoice.qbSyncStatus)) return { eligible: false, reason: "QuickBooks outcome needs review" };
    return quickBooksDraftSyncEligibility(validationCopy, client);
  }
  return quickBooksDraftSyncEligibility({ ...invoice, status: "Draft" }, client);
}

export function quickBooksInvoiceUrl(invoice) {
  return text(invoice?.qbId) ? `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(text(invoice.qbId))}` : "";
}

function contentSignature(invoice, client, invoicing) {
  return JSON.stringify(stable({
    payload: buildQuickBooksInvoicePayload(invoice, client, invoicing),
    clientId: invoice.clientId,
    status: invoice.status,
    delivery: { sentDate: invoice.sentDate, sentAt: invoice.sentAt, deliveredAt: invoice.deliveredAt, qbEmailStatus: invoice.qbEmailStatus },
    payment: { payment: invoice.payment, payments: invoice.payments, paidDate: invoice.paidDate, paidAt: invoice.paidAt, partial: invoice.partial },
    notes: invoice.notes,
    lineItems: invoice.lineItems,
  }));
}

function reviewSignature(invoice) {
  return JSON.stringify(stable({
    needsReview: !!invoice.qbNeedsReview,
    reviewRequired: !!invoice.qbReviewRequired,
    conflict: invoice.qbConflict,
    remoteChangesPending: !!invoice.qbRemoteChangesPending,
    pendingRemote: invoice.qbPendingRemote,
    pendingRemoteInvoice: invoice.qbPendingRemoteInvoice,
    syncConflict: invoice.qbSyncConflict,
    duplicate: !!invoice.qbDuplicate,
    spsOnly: !!invoice.qbSpsOnly,
    accountingExcluded: !!invoice.qbAccountingExcluded,
  }));
}

export function confirmQuickBooksSyncCandidate(current, reviewed, client, invoicing, { draftsOnly = false } = {}) {
  const eligibility = draftsOnly ? quickBooksDraftSyncEligibility(current, client) : quickBooksInvoiceSyncEligibility(current, client);
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (contentSignature(current, client, invoicing) !== contentSignature(reviewed, client, invoicing)) {
    throw new Error("This invoice changed since you opened it. Close this panel and review the latest invoice before syncing.");
  }
  return current;
}

export function applyConfirmedQuickBooksSync(current, submitted, result, client, invoicing) {
  if (text(current.qbId) && text(current.qbId) !== text(result.qbId)) {
    throw new Error("This invoice now has a different QuickBooks link. Review both records before syncing again.");
  }
  const reviewChanged = reviewSignature(current) !== reviewSignature(submitted);
  const changed = reviewChanged || contentSignature(current, client, invoicing) !== contentSignature(submitted, client, invoicing);
  if (!changed) {
    const synced = applyQuickBooksInvoiceSaveResult(current, result);
    // Syncing accounting content is not a customer-delivery action.
    return { ...synced, status: current.status || "Draft" };
  }
  const remote = result.invoice && Array.isArray(result.invoice.lineItems) ? {
    ...result.invoice,
    qbId: result.qbId,
    qbContentFingerprint: result.qbContentFingerprint || result.invoice.qbContentFingerprint || "",
  } : null;
  // A background refresh can discover a later QB revision while this request is
  // in flight. Its pending snapshot and conflict evidence outrank our response;
  // content equality alone cannot prove that the later review was resolved.
  const pendingRemote = current.qbPendingRemoteInvoice || remote;
  return {
    ...current,
    qbId: result.qbId,
    qbPushed: true,
    paymentLink: result.paymentLink || current.paymentLink || "",
    qbAuthoritative: false,
    locallyEdited: true,
    qbPendingLocalEdits: true,
    qbRemoteChangesPending: true,
    qbNeedsReview: true,
    qbSyncStatus: "conflict",
    qbSyncConflict: current.qbSyncConflict || { type: "quickbooks-sync-race", reason: reviewChanged ? "new-review-during-sync" : "newer-sps-edits-during-sync", currentFingerprint: pendingRemote?.qbContentFingerprint || result.qbContentFingerprint || null },
    ...(pendingRemote ? { qbPendingRemoteInvoice: pendingRemote } : {}),
  };
}

// The caller supplies the existing confirmed SPS mutation callback and authenticated
// QuickBooks request. This function has no customer-delivery or direct database path.
export async function syncInvoiceToQuickBooks({ invoice, client, invoicing, persistInvoice, request, draftsOnly = false }) {
  let submitted = invoice;
  let writeStarted = false;
  let confirmedResult = null;
  let intent = "";
  const persist = async (mutate) => {
    if (typeof persistInvoice !== "function") throw new Error("SPS cannot confirm invoice changes right now. Nothing was sent to QuickBooks.");
    const confirmed = await persistInvoice(invoice.id, mutate);
    if (!confirmed || text(confirmed.id) !== text(invoice.id)) throw new Error("SPS could not confirm this invoice. Close this panel and try again.");
    return confirmed;
  };
  const saveFailure = (details, extras = {}, requiresReview = true) => persist((current) => {
    // Never replace a newer QuickBooks association with an older response.
    if (extras.qbId && current.qbId && text(extras.qbId) !== text(current.qbId)) throw new Error("The QuickBooks link changed. Review this invoice.");
    const failed = applyQuickBooksInvoiceSyncFailure({ ...current, ...extras }, details);
    if (current.qbSyncConflict) failed.qbSyncConflict = current.qbSyncConflict;
    // A confirmed rejection or expired session has no ambiguous accounting
    // outcome. Preserve a concurrent review flag, but do not manufacture one.
    if (!requiresReview) failed.qbNeedsReview = !!current.qbNeedsReview;
    return failed;
  });
  try {
    submitted = await persist((current) => confirmQuickBooksSyncCandidate(current, invoice, client, invoicing, { draftsOnly }));
    const payload = buildQuickBooksInvoicePayload(submitted, client, invoicing);
    intent = quickBooksInvoiceIntentSignature(payload);
    writeStarted = true;
    const { response, data } = await request(submitted.qbId ? "update-invoice" : "create-invoice", payload);
    if (response.status === 401) {
      await saveFailure({ error: "QuickBooks session expired. Reconnect under Customize, then retry.", code: "QB_AUTH_EXPIRED" }, {}, false).catch(() => {});
      return { status: "failed", message: "Reconnect QuickBooks", reconnect: true };
    }
    if (data.recreate || response.status === 409) {
      await saveFailure({ error: data.error || "The QuickBooks invoice changed or was removed. Review it in the editor.", code: data.code || "QB_REVIEW_REQUIRED" }, {
        qbNeedsReview: true,
        qbSyncStatus: "conflict",
        qbSyncConflict: { type: "quickbooks-remote-update", reason: data.code || "quickbooks-invoice-missing", currentFingerprint: data.currentFingerprint || null },
      }).catch(() => {});
      return { status: "uncertain", message: "QuickBooks changed. Review this invoice in the editor" };
    }
    if (!response.ok || data.error) {
      if (data.createOutcomeUnknown) throw new Error(data.error || "The QuickBooks response was interrupted.");
      await saveFailure({ error: data.error || "QuickBooks rejected this invoice.", code: data.code }, {}, false).catch(() => {});
      return { status: "failed", message: data.error || "QuickBooks rejected this invoice" };
    }
    if (data.success !== true || !text(data.qbId)) throw new Error("QuickBooks returned an incomplete response. Review before retrying.");
    confirmedResult = data;
    const confirmed = await persist((current) => applyConfirmedQuickBooksSync(current, submitted, data, client, invoicing));
    return confirmed.qbNeedsReview
      ? { status: "uncertain", message: "In QuickBooks. Changes found during syncing need review", invoice: confirmed }
      : { status: "synced", message: "In QuickBooks. No customer message sent", invoice: confirmed };
  } catch (error) {
    // A preflight rejection happens before any accounting write; leave the newer
    // SPS record exactly as it is and require a fresh review.
    if (!writeStarted) return { status: "failed", message: error?.message || "Review the invoice before syncing" };
    const linkedUpdate = !!submitted.qbId;
    const extras = confirmedResult ? {
      qbId: confirmedResult.qbId,
      paymentLink: confirmedResult.paymentLink || submitted.paymentLink || "",
      qbPushed: true,
      qbNeedsReview: true,
      qbAuthoritative: false,
      qbPendingLocalEdits: true,
      qbSyncStatus: "local-save-unconfirmed",
    } : linkedUpdate ? {
      qbNeedsReview: true,
      qbPendingLocalEdits: true,
      qbSyncStatus: "conflict",
      qbSyncConflict: { type: "quickbooks-remote-update", reason: "update-outcome-unknown" },
    } : {
      locallyEdited: true,
      qbAuthoritative: false,
      qbPendingLocalEdits: true,
      qbSyncStatus: "create-outcome-unknown",
      qbCreateOutcomeUnknown: true,
      qbCreateIntentSignature: intent,
    };
    try {
      await saveFailure({ error: error?.message || "QuickBooks could not be confirmed.", code: confirmedResult ? "QB_LOCAL_SAVE_UNCONFIRMED" : linkedUpdate ? "QB_UPDATE_OUTCOME_UNKNOWN" : "QB_CREATE_OUTCOME_UNKNOWN" }, extras);
    } catch (_) { /* The visible outcome still blocks retries if the recovery write also fails. */ }
    return { status: "uncertain", message: confirmedResult ? "Saved in QuickBooks. SPS confirmation needs review" : "Connection interrupted. Review before retrying" };
  }
}
