import { isQuickBooksManagedInvoice } from "./invoiceBulkActions.js";
import { findInvoiceDeletionReferences, invoiceDeletionBlockedMessage } from "./invoiceDeletionGuard.js";
import { normalizeMaintenancePaymentLedger } from "./maintenancePaymentLedger.js";

const text = (value) => String(value == null ? "" : value).trim();
const list = (value) => Array.isArray(value) ? value : [];
const evidence = (value) => {
  if (value == null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};
const blocked = (code, reason) => ({ eligible: false, code, reason });

const stableValue = (value) => Array.isArray(value)
  ? value.map(stableValue)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
    : value;

export function invoiceDeletionReviewMatches(reviewed, latest) {
  const content = (invoice) => Object.fromEntries(Object.entries(invoice || {}).filter(([key]) => (
    !["number", "draftNumberAdjustedAt", "previousDraftNumber"].includes(key)
    && !key.startsWith("_")
  )));
  return !!reviewed && !!latest && JSON.stringify(stableValue(content(reviewed))) === JSON.stringify(stableValue(content(latest)));
}

function ledgerReferencesInvoice(invoice, ledger) {
  const id = text(invoice.id);
  const number = text(invoice.number);
  const qbId = text(invoice.qbId);
  const matches = (source) => (
    (!!id && text(source?.invoiceId || source?.sourceInvoiceId) === id)
    || (!!qbId && text(source?.qbInvoiceId || source?.sourceQbInvoiceId) === qbId)
    || (!!number && text(source?.invoiceNumber || source?.sourceInvoiceNumber) === number)
  );
  return Object.values(ledger.policies).some(matches)
    || Object.values(ledger.allocations).some((months) => (
      Object.values(months).some((allocation) => allocation.sources.some(matches))
    ));
}

// Deletion and renumbering are separate decisions. An unwanted completion draft
// may be deleted even though its visit provenance makes its number permanent.
export function invoiceBulkDeleteEligibility(invoice, {
  invoices,
  estimates = [],
  schedule = [],
  ledger,
  totalOf = (entry) => entry?.total,
} = {}) {
  const id = text(invoice?.id);
  if (!id) return blocked("missing-id", "Missing invoice identifier");
  if (Array.isArray(invoices) && invoices.filter((entry) => text(entry?.id) === id).length !== 1) {
    return blocked("ambiguous-id", "Invoice identifier changed or is duplicated");
  }
  if (text(invoice.status).toLowerCase() !== "draft") return blocked("not-draft", "Only drafts can be deleted together");
  const syncStatus = text(invoice.qbSyncStatus).toLowerCase();
  const source = text(invoice.source || invoice.origin).toLowerCase();
  if (isQuickBooksManagedInvoice(invoice)
    || (syncStatus && !["local", "not-synced", "sps-only"].includes(syncStatus))
    || ["quickbooks", "qb"].includes(source)
    || [
    "qbId", "qbSyncToken", "qbPushed", "qbAuthoritative", "qbNeedsReview",
    "qbReviewRequired", "qbConflict", "qbPendingRemote", "qbPendingRemoteInvoice", "qbDuplicate",
  ].some((key) => evidence(invoice[key]))) {
    return blocked("quickbooks", "Linked to QuickBooks or awaiting accounting review");
  }
  if ([
    "sentDate", "sentAt", "emailedAt", "emailSentAt", "deliveredAt", "deliveryDate",
    "qbEmailStatus", "viewedAt", "clientViewedAt", "openedAt", "downloadedAt",
    "exportedAt", "printedAt", "sharedAt", "paymentLink",
  ].some((key) => evidence(invoice[key]))) {
    return blocked("shared", "Already sent, shared, or exported");
  }
  const total = Number(totalOf(invoice));
  const balance = invoice.balance == null || text(invoice.balance) === "" ? null : Number(invoice.balance);
  if (["paidDate", "paidAt", "payment", "payments", "paymentId", "paymentStatus", "partial"].some((key) => evidence(invoice[key]))
    || ["amountPaid", "paidAmount", "creditApplied", "creditsApplied", "paymentAmount"].some((key) => Number(invoice[key]) > 0)
    || (balance !== null && (!Number.isFinite(balance) || (Number.isFinite(total) && Math.round(balance * 100) < Math.round(total * 100))))) {
    return blocked("payment", "Has a payment, credit, or adjusted balance");
  }
  const references = findInvoiceDeletionReferences(invoice, estimates, schedule);
  if (references.blocked) return blocked("job-linked", invoiceDeletionBlockedMessage(invoice, references));
  const normalizedLedger = normalizeMaintenancePaymentLedger(ledger);
  if (!normalizedLedger) return blocked("coverage-unavailable", "Payment coverage must be checked before deleting");
  if (ledgerReferencesInvoice(invoice, normalizedLedger)) {
    return blocked("payment-coverage", "Used by prepaid or maintenance payment coverage");
  }
  return { eligible: true, code: "", reason: "Ready to delete" };
}

export function partitionInvoiceBulkDeletion(invoices, selectedIds, context = {}) {
  const selected = new Set(list(selectedIds).map(text).filter(Boolean));
  const seen = new Set();
  const rows = list(invoices).flatMap((invoice) => {
    const id = text(invoice?.id);
    if (!selected.has(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ invoice, ...invoiceBulkDeleteEligibility(invoice, { ...context, invoices }) }];
  });
  for (const id of selected) {
    if (!seen.has(id)) rows.push({ invoice: { id }, ...blocked("missing", "Invoice is no longer in this list") });
  }
  return { ready: rows.filter((row) => row.eligible), skipped: rows.filter((row) => !row.eligible), rows };
}

// The supplied deletion handler rechecks each fresh shared record and confirms
// persistence. Never optimistically hide a row, run deletions in parallel, or
// convert an absent/ambiguous receipt into success.
export async function deleteSelectedInvoiceDrafts({ invoices, selectedIds, context, onDelete, onOutcome }) {
  const plan = partitionInvoiceBulkDeletion(invoices, selectedIds, context);
  const outcomes = [];
  const publish = (outcome) => { outcomes.push(outcome); onOutcome?.(outcome); };
  for (const row of plan.skipped) publish({ id: text(row.invoice.id), status: "skipped", message: row.reason });
  for (const { invoice } of plan.ready) {
    const id = text(invoice.id);
    try {
      const receipt = typeof onDelete === "function" ? await onDelete(id, { draftOnly: true }) : null;
      if (receipt?.ok === true) {
        publish({ id, status: "deleted", message: receipt.existing ? "Already removed" : "Deleted", receipt });
      } else {
        publish({ id, status: receipt?.protected ? "skipped" : "failed", message: text(receipt?.error) || "Deletion was not confirmed. The invoice remains selected." });
      }
    } catch (error) {
      publish({ id, status: "failed", message: text(error?.message) || "Deletion failed. The invoice remains selected." });
    }
  }
  return {
    outcomes,
    deletedIds: outcomes.filter((outcome) => outcome.status === "deleted").map((outcome) => outcome.id),
    retainedIds: outcomes.filter((outcome) => outcome.status !== "deleted").map((outcome) => outcome.id),
  };
}
