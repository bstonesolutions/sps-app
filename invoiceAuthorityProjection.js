// Display projections only. The original pending envelope remains the recovery
// source, and generic writes still reach the server guard with their full intent.
import { stableInvoiceReviewJSON } from "./invoiceReviewIdentity.js";

const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const text = value => String(value ?? "").trim();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const same = (left, right) => stableInvoiceReviewJSON(left) === stableInvoiceReviewJSON(right);
const fields = new Set([
  "number", "clientId", "clientName", "date", "issueDate", "dueDate", "sentDate", "paidDate", "status",
  "taxRate", "taxAmount", "discountType", "discount", "invoiceDiscountType", "invoiceDiscount",
  "subTotal", "subtotal", "total", "balance", "items", "lines", "lineItems", "partial",
  "lateFeeAppliedAt", "locallyEdited",
]);
const lineMetadata = new Set([
  "id", "unitCost", "costKnown", "knownUnitCost", "refId", "bundleItems", "bundleNote", "chargeType", "chargeLabel",
  "sourceEstimateLineId", "sourceVisitLineId", "sourceStopId", "sourceStopIds", "sourceCompletionReceiptId",
  "sourceCompletionReceiptIds", "serviceMonth", "sourceVisitDates", "maintenanceService",
]);
const protectedField = key => key.startsWith("qb") || fields.has(key);

function matchingInvoice(rows, invoice) {
  if (!Array.isArray(rows) || !record(invoice)) return null;
  const id = text(invoice.id), qbId = text(invoice.qbId);
  const exact = rows.filter(row => record(row) && id && text(row.id) === id);
  if (exact.length === 1) {
    const otherQbId = text(exact[0].qbId);
    return qbId && otherQbId && qbId !== otherQbId ? null : exact[0];
  }
  if (exact.length || !qbId) return null;
  const linked = rows.filter(row => record(row) && text(row.qbId) === qbId);
  return linked.length === 1 ? linked[0] : null;
}

function accountingSnapshot(invoice) {
  if (!record(invoice)) return null;
  return Object.fromEntries(Object.entries(invoice).filter(([key]) => (fields.has(key) && key !== "locallyEdited")
    || key === "qbId" || key === "qbCustomerId").map(([key, value]) => [key,
    key === "lineItems" && Array.isArray(value)
      ? value.map(line => record(line) ? Object.fromEntries(Object.entries(line).filter(([field]) => !lineMetadata.has(field))) : line)
      : value,
  ]));
}

// Old native builds appended exactly this generated object. A label or isLateFee
// alone is never enough evidence to discard a real manually entered charge.
export function withoutLegacyAutomaticInvoiceFee(invoice, references = []) {
  if (!record(invoice) || !text(invoice.qbId) || !/^\d{4}-\d{2}-\d{2}$/.test(invoice.lateFeeAppliedAt || "")
    || !Array.isArray(invoice.lineItems) || invoice.lineItems.length < 2) return invoice;
  const line = invoice.lineItems.at(-1);
  if (!record(line) || !same(Object.keys(line).sort(), ["id", "desc", "qty", "unitPrice", "amount", "taxable", "isLateFee", "kind"].sort())
    || line.id !== `lf_${invoice.id}_${invoice.lateFeeAppliedAt}` || line.qty !== "1"
    || line.taxable !== false || line.isLateFee !== true || line.kind !== "lateFee"
    || typeof line.desc !== "string" || !line.desc.trim() || typeof line.unitPrice !== "string"
    || !/^\d+\.\d{2}$/.test(line.unitPrice) || !(Number(line.unitPrice) > 0)
    || typeof line.amount !== "number" || !Number.isFinite(line.amount) || line.amount !== Number(line.unitPrice)) return invoice;
  const clean = { ...invoice, lineItems: invoice.lineItems.slice(0, -1) };
  delete clean.lateFeeAppliedAt;
  return references.some(reference => matchingInvoice([reference], invoice)
    && same(accountingSnapshot(clean), accountingSnapshot(reference))) ? clean : invoice;
}

export function normalizeInvoiceProjectionIntent(base, local, canonical) {
  if (!Array.isArray(local)) return local;
  return local.map(invoice => {
    const references = [matchingInvoice(base, invoice), matchingInvoice(canonical, invoice)].filter(Boolean);
    const clean = withoutLegacyAutomaticInvoiceFee(invoice, references);
    if (clean === invoice) return invoice;
    const reference = references.find(value => same(accountingSnapshot(clean), accountingSnapshot(value)));
    // Pending flags created around the old fee are not an additional business
    // edit. Restore their known prior values so they cannot recreate a review
    // after the only accounting difference has been identified and removed.
    for (const key of ["locallyEdited", "qbPendingLocalEdits", "qbLocalChangesPending", "qbNeedsReview", "qbSyncStatus"]) {
      if (key === "qbSyncStatus" && !["dirty", "local-edits", "pending", "pending-push", "pending_push", "conflict"].includes(clean[key])) continue;
      if (key !== "qbSyncStatus" && clean[key] !== true) continue;
      if (own(reference, key)) clean[key] = reference[key];
      else delete clean[key];
    }
    return clean;
  });
}

export function projectInvoiceAccountingAuthority(base, displayed, canonical) {
  if (!Array.isArray(displayed) || !Array.isArray(canonical)) return displayed;
  return displayed.map(invoice => {
    const saved = matchingInvoice(canonical, invoice);
    if (!saved) return invoice;
    const before = matchingInvoice(base, saved);
    const newerAuthority = ["qbReviewResolution", "qbWriteReview"].some(key => record(saved[key])
      && !same(before?.[key], saved[key]));
    const next = { ...invoice };
    if (newerAuthority) {
      const sameAccounting = same(accountingSnapshot(invoice), accountingSnapshot(saved));
      for (const key of Object.keys(next)) if (protectedField(key)) delete next[key];
      for (const [key, value] of Object.entries(saved)) if (protectedField(key)) next[key] = value;
      // Cost/provenance-only work is safe only when every customer-facing
      // accounting field still matches, the same rule as the server guard.
      if (sameAccounting && Array.isArray(invoice.lineItems)) next.lineItems = invoice.lineItems;
    }
    // These are server receipts, never user-editable local fields. Their removal
    // is also meaningful when the owner has resolved an earlier review.
    for (const key of ["qbReviewResolution", "qbWriteReview"]) {
      if (own(saved, key)) next[key] = saved[key];
      else delete next[key];
    }
    return next;
  });
}
