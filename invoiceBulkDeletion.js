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
  const allowRenumber = [reviewed, latest].every((invoice) => text(invoice?.status).toLowerCase() === "draft"
    && !text(invoice?.qbId) && !isQuickBooksManagedInvoice(invoice));
  const content = (invoice) => Object.fromEntries(Object.entries(invoice || {}).filter(([key]) => (
    !(allowRenumber && ["number", "draftNumberAdjustedAt", "previousDraftNumber"].includes(key))
    && !key.startsWith("_")
  )));
  return !!reviewed && !!latest && JSON.stringify(stableValue(content(reviewed))) === JSON.stringify(stableValue(content(latest)));
}

function invoiceSourceMatcher(invoice) {
  const id = text(invoice.id);
  const number = text(invoice.number);
  const qbId = text(invoice.qbId);
  return (source) => (
    (!!id && text(source?.invoiceId) === id)
    || (!!text(source?.sourceInvoiceId) && [id, qbId].filter(Boolean).includes(text(source.sourceInvoiceId)))
    || (!!qbId && text(source?.qbInvoiceId || source?.sourceQbInvoiceId) === qbId)
    || (!!number && text(source?.invoiceNumber || source?.sourceInvoiceNumber) === number)
  );
}

function ledgerReferencesInvoice(invoice, ledger) {
  const matches = invoiceSourceMatcher(invoice);
  return Object.values(ledger.policies).some(matches)
    || Object.values(ledger.allocations).some((months) => (
      Object.values(months).some((allocation) => allocation.sources.some(matches))
    ));
}

// A reviewed unpaid invoice may be detached from an open maintenance match.
// Payment, partial-payment, prepayment, waiver, and uncertain allocations are
// accounting evidence and remain protected, including their unrelated sources.
export function unlinkUnpaidInvoiceCoverage(invoice, rawLedger) {
  const ledger = normalizeMaintenancePaymentLedger(rawLedger);
  if (!ledger) return null;
  const next = structuredClone(ledger);
  const matches = invoiceSourceMatcher(invoice);
  for (const [clientId, months] of Object.entries(next.allocations)) {
    for (const [month, allocation] of Object.entries(months)) {
      if (allocation.status !== "due") continue;
      const sources = allocation.sources.filter((source) => source.kind !== "invoice" || !matches(source));
      if (sources.length === allocation.sources.length) continue;
      if (!sources.length) delete months[month];
      else months[month] = { ...allocation, sources, allocatedCents: sources.reduce((sum, source) => sum + (source.amountCents || 0), 0) };
    }
    if (!Object.keys(months).length) delete next.allocations[clientId];
  }
  return normalizeMaintenancePaymentLedger(next);
}

// Deletion and renumbering are separate decisions. An unwanted completion draft
// may be deleted even though its visit provenance makes its number permanent.
export function invoiceBulkDeleteEligibility(invoice, {
  invoices,
  estimates = [],
  schedule = [],
  ledger,
  totalOf = (entry) => entry?.total,
  includeQuickBooks = false,
  unlinkJobs = false,
  reviewedInvoice = null,
} = {}) {
  const id = text(invoice?.id);
  if (!id) return blocked("missing-id", "Missing invoice identifier");
  if (Array.isArray(invoices) && invoices.filter((entry) => text(entry?.id) === id).length !== 1) {
    return blocked("ambiguous-id", "Invoice identifier changed or is duplicated");
  }
  const status = text(invoice.status).toLowerCase();
  if (!["draft", "sent", "overdue"].includes(status)) return blocked("not-unpaid", "Only unpaid draft, sent, or overdue invoices can be deleted");
  const reviewed = invoiceDeletionReviewMatches(reviewedInvoice, invoice);
  if (status !== "draft" && !reviewed) return blocked("review-required", "Review this invoice before deleting it");
  const syncStatus = text(invoice.qbSyncStatus).toLowerCase();
  const source = text(invoice.source || invoice.origin).toLowerCase();
  const quickBooks = isQuickBooksManagedInvoice(invoice)
    || (syncStatus && !["local", "not-synced", "sps-only"].includes(syncStatus))
    || ["quickbooks", "qb"].includes(source)
    || [
    "qbId", "qbSyncToken", "qbPushed", "qbAuthoritative", "qbNeedsReview",
    "qbReviewRequired", "qbConflict", "qbPendingRemote", "qbPendingRemoteInvoice", "qbDuplicate",
  ].some((key) => evidence(invoice[key]));
  if (quickBooks) {
    if (!includeQuickBooks) return blocked("quickbooks", "Include QuickBooks invoices to delete this linked invoice");
    if (!text(invoice.qbId) || ["qbNeedsReview", "qbReviewRequired", "qbConflict", "qbPendingRemote", "qbPendingRemoteInvoice", "qbDuplicate", "qbCreateOutcomeUnknown"].some((key) => evidence(invoice[key]))
      || ["pending", "create-outcome-unknown"].includes(syncStatus)) return blocked("quickbooks-review", "Resolve this invoice's QuickBooks review before deleting it");
    if (!reviewed) return blocked("review-required", "Review this QuickBooks invoice before deleting it");
  }
  if ([
    "sentDate", "sentAt", "emailedAt", "emailSentAt", "deliveredAt", "deliveryDate",
    "qbEmailStatus", "viewedAt", "clientViewedAt", "openedAt", "downloadedAt",
    "exportedAt", "printedAt", "sharedAt", "paymentLink",
  ].some((key) => evidence(invoice[key])) && !reviewed) {
    return blocked("shared", "Already sent, shared, or exported");
  }
  const total = Number(totalOf(invoice));
  const balance = invoice.balance == null || text(invoice.balance) === "" ? null : Number(invoice.balance);
  if (["paidDate", "paidAt", "payment", "payments", "paymentId", "partial"].some((key) => evidence(invoice[key]))
    || (evidence(invoice.paymentStatus) && !["unpaid", "due", "open", "pending"].includes(text(invoice.paymentStatus).toLowerCase()))
    || ["amountPaid", "paidAmount", "creditApplied", "creditsApplied", "paymentAmount"].some((key) => Number(invoice[key]) > 0)
    || (balance !== null && (!Number.isFinite(balance) || (Number.isFinite(total) && Math.round(balance * 100) < Math.round(total * 100))))) {
    return blocked("payment", "Has a payment, credit, or adjusted balance");
  }
  const references = findInvoiceDeletionReferences(invoice, estimates, schedule);
  if (references.blocked && !unlinkJobs) return blocked("job-linked", invoiceDeletionBlockedMessage(invoice, references));
  if (references.blocked && !reviewed) return blocked("review-required", "Review this invoice before removing its job links");
  const normalizedLedger = normalizeMaintenancePaymentLedger(ledger);
  if (!normalizedLedger) return blocked("coverage-unavailable", "Payment coverage must be checked before deleting");
  if (ledgerReferencesInvoice(invoice, unlinkJobs ? unlinkUnpaidInvoiceCoverage(invoice, normalizedLedger) : normalizedLedger)) {
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
    const reviewedInvoice = list(context.reviewedInvoices).find((entry) => text(entry?.id) === id) || context.reviewedInvoice;
    return [{ invoice, reviewedInvoice, ...invoiceBulkDeleteEligibility(invoice, { ...context, reviewedInvoice, invoices }) }];
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
  for (const { invoice, reviewedInvoice } of plan.ready) {
    const id = text(invoice.id);
    try {
      const receipt = typeof onDelete === "function" ? await onDelete(id, {
        draftOnly: !context?.includeQuickBooks && !context?.unlinkJobs && !context?.reviewedInvoices && !context?.reviewedInvoice,
        includeQuickBooks: context?.includeQuickBooks === true,
        unlinkJobs: context?.unlinkJobs === true,
        reviewedInvoice: reviewedInvoice || invoice,
      }) : null;
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
