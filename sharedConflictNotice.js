// Presentation only. The shared-state store remains the authority for unresolved conflicts.
export function currentSharedConflict(conflicts, previous = null) {
  const active = (Array.isArray(conflicts) ? conflicts : []).filter(item => item && item.key);
  const next = active.find(item => item.key === previous?.key) || active[0] || null;
  return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
}

const FIELD_LABELS = {
  qbId: "QuickBooks link", qbSyncToken: "QuickBooks version", qbSyncStatus: "QuickBooks sync status",
  qbLastUpdatedTime: "QuickBooks update", qbContentFingerprint: "QuickBooks invoice revision",
  qbBaseContentFingerprint: "QuickBooks invoice revision", qbPendingRemoteInvoice: "QuickBooks invoice",
  qbSyncAttemptedAt: "QuickBooks sync attempt", qbSyncError: "QuickBooks sync result",
  clientId: "Client", clientName: "Client name", lineItems: "Line items", items: "Line items",
  qty: "Quantity", rate: "Rate", price: "Price", total: "Total", balance: "Balance",
  subTotal: "Subtotal", taxAmount: "Tax", status: "Status", notes: "Notes", number: "Invoice number",
  createdAt: "Created date", updatedAt: "Updated date", sentDate: "Sent date", paidDate: "Paid date",
};

export function sharedConflictReview(conflict) {
  const items = Array.isArray(conflict?.conflicts) ? conflict.conflicts : [];
  const paths = items.length ? items.map(item => item?.path) : (conflict?.paths || []);
  const fields = [...new Set(paths.map(path => {
    const leaf = String(path || "").split(".").pop() || "";
    return FIELD_LABELS[leaf] || "Saved details";
  }))];
  const needsFullReview = items.some(item => /legacy|delete|restore|reorder|invalid|duplicate/.test(item?.kind || ""))
    || paths.some(path => path === "$");
  return {
    fields: fields.slice(0, 4),
    needsFullReview,
    explanation: needsFullReview
      ? "This device and the saved copy have different versions. Review your work before choosing which version to keep."
      : "Choose which overlapping changes to keep. Changes to other fields will be combined.",
  };
}
