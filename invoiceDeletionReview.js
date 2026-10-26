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

// Linked invoice deletion is one server operation. It must not flush a device's
// whole invoice list or wait for an unrelated client's pending changes.
export async function deleteConfirmedQuickBooksInvoice({ invoice, unlinkJobs = false, store, requestDelete, adopt }) {
  const expectedInvoice = snapshotInvoiceDeletionReview(invoice);
  const id = text(expectedInvoice?.id);
  if (!id || !text(expectedInvoice?.qbId)) throw new Error("Choose the saved QuickBooks invoice before deleting it.");
  const identity = store.captureIdentity();
  const current = () => {
    if (!store.isCurrentIdentity(identity)) throw new Error("The signed-in account changed. Reopen this invoice in the original account to confirm deletion.");
  };
  current();
  const receipt = await requestDelete({
    qb_id: expectedInvoice.qbId, reviewed_invoice: expectedInvoice,
    unlinkJobs: unlinkJobs === true, completeInSps: true,
  }, identity);
  current();
  if (receipt?.success !== true || receipt.complete !== true || text(receipt.deletedInvoiceId) !== id || receipt.actorId !== identity.uid) {
    throw new Error(receipt?.error || "Deletion was not confirmed in SPS Way. The invoice remains available to retry.");
  }
  let accepted;
  try { accepted = await store.acceptInvoiceDeletionSnapshot(receipt, identity, { expectedInvoice }); }
  catch (error) { return {
    ok: false, serverConfirmed: true,
    error: `The invoice was deleted on the server, but this device could not refresh its list. ${error?.message || "Retry to finish refreshing it."}`,
  }; }
  current();
  if (accepted?.ok !== true) return {
    ok: false, serverConfirmed: true, targetChanged: accepted?.targetChanged === true,
    error: accepted?.error?.message || "The invoice was deleted on the server, but this device could not confirm its updated list. Retry to finish refreshing it.",
  };
  const values = accepted.values;
  if (!Array.isArray(values?.sps_invoices) || values.sps_invoices.some(row => text(row?.id) === id)) return {
    ok: false, serverConfirmed: true,
    error: "The invoice was deleted on the server, but this device still has changes for it. Your local work has been preserved for review.",
  };
  await adopt(values, { deletedInvoice: { id, before: expectedInvoice } });
  current();
  return { ok: true, existing: receipt.alreadyGone === true, renumbered: receipt.renumbered || [],
    recoveryPending: accepted.recoveryPending === true,
    ...(accepted.recoveryPending ? { message: "Invoice removed. Newer local edits are preserved for review." } : {}),
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
