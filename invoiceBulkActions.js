const text = (value) => String(value == null ? "" : value).trim();
const list = (value) => (Array.isArray(value) ? value : []);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const invoiceKey = (invoice) => text(invoice?.id);

const parseInvoiceDate = (value) => {
  const raw = text(value);
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (mdy) {
    const date = new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const toMDY = (date) => `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
const cents = (value) => Math.round((Number(value) || 0) * 100);

export const BULK_EDITABLE_INVOICE_FIELDS = Object.freeze(["status", "termsDays", "dueDate", "notes"]);

export function invoiceSelectionForVisible(selectedIds, visibleInvoices, checked) {
  const selected = new Set(list(selectedIds).map(text).filter(Boolean));
  list(visibleInvoices).map(invoiceKey).filter(Boolean).forEach((id) => {
    if (checked) selected.add(id);
    else selected.delete(id);
  });
  return [...selected];
}

export function selectedFilteredInvoiceIds(filteredInvoices, selectedIds) {
  const selected = new Set(list(selectedIds).map(text).filter(Boolean));
  return list(filteredInvoices).map(invoiceKey).filter((id) => id && selected.has(id));
}

export function pruneInvoiceSelection(selectedIds, visibleInvoices) {
  return selectedFilteredInvoiceIds(visibleInvoices, selectedIds);
}

export function summarizeSelectedInvoices(filteredInvoices, selectedIds, amountOf = (invoice) => invoice?._total) {
  const ids = new Set(selectedFilteredInvoiceIds(filteredInvoices, selectedIds));
  const totalCents = list(filteredInvoices).reduce((sum, invoice) => (
    ids.has(invoiceKey(invoice)) ? sum + cents(amountOf(invoice)) : sum
  ), 0);
  return { ids: [...ids], count: ids.size, total: totalCents / 100 };
}

export function isQuickBooksManagedInvoice(invoice) {
  if (invoice?.qbSpsOnly === true || invoice?.qbAccountingExcluded === true || text(invoice?.qbSyncStatus).toLowerCase() === "sps-only") return false;
  const syncStatus = text(invoice?.qbSyncStatus).toLowerCase();
  const source = text(invoice?.source || invoice?.origin).toLowerCase();
  return !!(
    text(invoice?.qbId)
    || invoice?.qbPushed === true
    || invoice?.qbAuthoritative === true
    || text(invoice?.qbSyncToken)
    || invoice?.qbNeedsReview === true
    || invoice?.qbReviewRequired === true
    || invoice?.qbConflict === true
    || invoice?.qbPendingRemote === true
    || invoice?.qbDuplicate === true
    || (syncStatus && !["local", "not-synced", "sps-only"].includes(syncStatus))
    || source === "quickbooks"
    || source === "qb"
  );
}

export function invoiceBulkEditEligibility(invoice) {
  if (!invoiceKey(invoice)) return { eligible: false, reason: "missing-id" };
  if (isQuickBooksManagedInvoice(invoice)) return { eligible: false, reason: "quickbooks-managed" };
  const status = text(invoice?.status).toLowerCase();
  if (["paid", "void"].includes(status)) return { eligible: false, reason: "closed" };
  return { eligible: true, reason: "" };
}

export function sanitizeBulkInvoicePatch(requested = {}) {
  const patch = {};
  if (["Draft", "Sent"].includes(requested.status)) patch.status = requested.status;
  if (Object.prototype.hasOwnProperty.call(requested, "termsDays")) {
    const termsDays = Number(requested.termsDays);
    if (Number.isInteger(termsDays) && termsDays >= 0 && termsDays <= 365) patch.termsDays = termsDays;
  }
  if (Object.prototype.hasOwnProperty.call(requested, "dueDate") && parseInvoiceDate(requested.dueDate)) patch.dueDate = text(requested.dueDate);
  if (Object.prototype.hasOwnProperty.call(requested, "notes") || Object.prototype.hasOwnProperty.call(requested, "terms")) patch.notes = String(requested.notes ?? requested.terms ?? "");
  return patch;
}

export function applySafeBulkInvoiceEdits(invoices, selectedIds, requestedPatch = {}, { today = new Date() } = {}) {
  const selected = new Set(list(selectedIds).map(text).filter(Boolean));
  const patch = sanitizeBulkInvoicePatch(requestedPatch);
  const updatedIds = [];
  const skipped = [];

  if (!Object.keys(patch).length) return { invoices: list(invoices), patch, updatedIds, skipped };

  const nextInvoices = list(invoices).map((invoice) => {
    const id = invoiceKey(invoice);
    if (!selected.has(id)) return invoice;
    const eligibility = invoiceBulkEditEligibility(invoice);
    if (!eligibility.eligible) {
      skipped.push({ id, reason: eligibility.reason });
      return invoice;
    }

    const next = { ...invoice };
    if (hasOwn(patch, "status")) {
      next.status = patch.status;
      if (patch.status === "Sent" && !text(next.sentDate)) next.sentDate = toMDY(today);
    }
    if (hasOwn(patch, "notes")) next.notes = patch.notes;
    if (hasOwn(patch, "termsDays")) next.termsDays = patch.termsDays;
    if (hasOwn(patch, "dueDate")) {
      next.dueDate = patch.dueDate;
    } else if (hasOwn(patch, "termsDays")) {
      const issued = parseInvoiceDate(invoice.date || invoice.issueDate);
      if (issued) {
        const due = new Date(issued);
        due.setDate(due.getDate() + patch.termsDays);
        next.dueDate = toMDY(due);
      }
    }
    updatedIds.push(id);
    return next;
  });

  return { invoices: nextInvoices, patch, updatedIds, skipped };
}

export function applyInvoiceBulkEdits(invoices, selectedIds, changes = {}, options = {}) {
  const result = applySafeBulkInvoiceEdits(invoices, selectedIds, changes, options);
  return {
    ...result,
    changed: result.invoices.filter((invoice) => result.updatedIds.includes(invoiceKey(invoice))),
  };
}
