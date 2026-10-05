export const INVOICE_DELETION_CONFLICT_KEYS = ["sps_invoices", "sps_estimates", "sps_schedule", "sps_maintenance_billing"];
const text = value => String(value == null ? "" : value).trim();

export function snapshotInvoiceDeletionReview(invoice) {
  return invoice && typeof invoice === "object" ? structuredClone(invoice) : null;
}

export function invoiceDeletionReviewRequest(invoice, unlinkJobs = false) {
  if (!text(invoice?.id)) throw new Error("Choose an invoice to review before deleting it.");
  return {
    id: invoice.id,
    options: { reviewedInvoice: snapshotInvoiceDeletionReview(invoice), includeQuickBooks: !!invoice.qbId, unlinkJobs: unlinkJobs === true },
  };
}

export function invoiceDeletionRelatedConflicts(store) {
  const conflicts = typeof store?.listConflicts === "function" ? store.listConflicts() : [];
  return (Array.isArray(conflicts) ? conflicts : []).filter(conflict => INVOICE_DELETION_CONFLICT_KEYS.includes(conflict?.key));
}

// Only called by an explicit version-choice button. Never resolves another key,
// flushes unrelated work, or resumes a deletion after resolving the conflict.
export async function resolveInvoiceDeletionConflict(store, conflict, strategy) {
  if (!INVOICE_DELETION_CONFLICT_KEYS.includes(conflict?.key) || !["remote", "local"].includes(strategy)) {
    throw new Error("Choose one of the displayed invoice-related changes to review.");
  }
  if (typeof store?.resolveConflict !== "function") throw new Error("Shared changes cannot be resolved here. Reopen the invoice from the saved list.");
  const receipt = await store.resolveConflict(conflict.key, strategy);
  if (receipt?.ok !== true) {
    throw new Error(receipt?.conflict
      ? "The saved copy changed again. Review the updated fields before choosing."
      : receipt?.error?.message || "Your choice has not finished saving. The pending changes are still available.");
  }
  return { key: conflict.key, strategy, conflicts: invoiceDeletionRelatedConflicts(store) };
}

export async function refreshInvoiceDeletionReview(store, invoiceId) {
  if (typeof store?.refresh !== "function") throw new Error("The latest invoice could not be loaded. Close this review and reopen the invoice.");
  const result = await store.refresh("sps_invoices");
  if (result?.ok !== true) throw new Error(result?.error?.message || "The latest invoice could not be loaded. Nothing was deleted.");
  let invoices = result.exists === false ? [] : result.value;
  for (let pass = 0; pass < 2 && typeof invoices === "string"; pass += 1) {
    try { invoices = JSON.parse(invoices); } catch (_) { throw new Error("The saved invoice list could not be read. Nothing was deleted."); }
  }
  if (!Array.isArray(invoices)) throw new Error("The saved invoice list could not be read. Nothing was deleted.");
  const matches = invoices.filter(invoice => text(invoice?.id) === text(invoiceId));
  if (matches.length > 1) throw new Error("This invoice identifier appears more than once. Review the saved invoice list before deleting.");
  return { invoice: snapshotInvoiceDeletionReview(matches[0]), conflicts: invoiceDeletionRelatedConflicts(store) };
}
