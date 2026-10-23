// SPS-owned context carried through a confirmed QuickBooks write. Accounting,
// identity, review receipts, and sync markers are deliberately not transferable.
import { stableInvoiceReviewJSON } from "./invoiceReviewIdentity.js";
export const SPS_INVOICE_METADATA_FIELDS = [
  "notes", "internalNotes", "termsDays", "title", "description", "source", "createdAt",
  "sourceEstimateId", "sourceEstimateNumber", "sourceEstimateTitle", "sourceEstimateStatus",
  "sourceEstimateTaxModel", "sourceEstimateTaxMigration", "sourceEstimateTaxMigrationConfirmedAt",
  "sourceEstimateTaxMigrationSource", "sourceEstimatePriorTotal", "sourceEstimateCorrectedTotal",
  "sourceVisitId", "sourceVisitIds", "sourceStopId", "sourceStopIds",
  "sourceCompletionReceiptId", "sourceCompletionReceiptIds", "sourceVisitDates",
  "serviceMonth", "serviceDate", "autoPeriod", "autoDraftKey",
];
export const SPS_INVOICE_LINE_METADATA_FIELDS = [
  "id", "qbLineId", "unitCost", "costKnown", "knownUnitCost", "refId", "bundleItems", "bundleNote",
  "chargeType", "chargeLabel", "sourceEstimateLineId", "sourceVisitLineId",
  "sourceStopId", "sourceStopIds", "sourceCompletionReceiptId", "sourceCompletionReceiptIds",
  "serviceMonth", "serviceDate", "sourceVisitDates", "maintenanceService",
];
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));
const pick = (source, fields) => Object.fromEntries(fields.filter(key => record(source)
  && Object.hasOwn(source, key) && source[key] !== undefined).map(key => [key, copy(source[key])]));
const sameId = (left, right) => left != null && String(left) !== "" && String(left) === String(right ?? "");
const sameValue = (left, right) => stableInvoiceReviewJSON(left) === stableInvoiceReviewJSON(right);

export function invoiceSpsMetadata(invoice) {
  const metadata = pick(invoice, SPS_INVOICE_METADATA_FIELDS);
  if (Array.isArray(invoice?.lineItems)) metadata.lineItems = invoice.lineItems.map(line => pick(line, SPS_INVOICE_LINE_METADATA_FIELDS));
  return metadata;
}

export function mergeInvoiceSpsMetadataResult(current, submitted, { isNew = false } = {}) {
  const metadata = invoiceSpsMetadata(submitted?.spsMetadata || submitted || {});
  const hasBase = record(submitted?.spsMetadataBase);
  const base = hasBase ? invoiceSpsMetadata(submitted.spsMetadataBase) : {};
  const { lineItems: metadataLines = [], ...fields } = metadata;
  const conflicts = [];
  const mergeFields = (saved, desired, original, path, newRecord = isNew) => {
    const result = { ...saved };
    for (const [key, value] of Object.entries(desired)) {
      if (newRecord || (Object.hasOwn(saved, key) && sameValue(saved[key], value))) result[key] = value;
      else if (hasBase && Object.hasOwn(original || {}, key) && sameValue(original[key], value)) continue;
      else if (hasBase && Object.hasOwn(saved, key) === Object.hasOwn(original || {}, key) && sameValue(saved[key], original?.[key])) result[key] = value;
      else if (!Object.hasOwn(saved, key) && (!hasBase || !Object.hasOwn(original || {}, key))) result[key] = value;
      else conflicts.push(`${path}${key}`);
    }
    return result;
  };
  const next = mergeFields(current, fields, base, "");
  const proposed = { ...current, ...fields };
  if (!Array.isArray(submitted?.lineItems)) return { invoice: next, proposedInvoice: proposed, conflicts };
  const lines = submitted.lineItems.map(line => {
    const matches = (current.lineItems || []).filter(saved => sameId(line.id, saved.id) || sameId(line.qbLineId, saved.qbLineId));
    const supplements = metadataLines.filter(saved => sameId(line.id, saved.id) || sameId(line.qbLineId, saved.qbLineId));
    const originals = (base.lineItems || []).filter(saved => sameId(line.id, saved.id) || sameId(line.qbLineId, saved.qbLineId));
    const saved = matches.length === 1 ? matches[0] : {};
    const desired = supplements.length === 1 ? pick(supplements[0], SPS_INVOICE_LINE_METADATA_FIELDS) : {};
    const mergedMetadata = mergeFields(pick(saved, SPS_INVOICE_LINE_METADATA_FIELDS), desired,
      originals.length === 1 ? originals[0] : {}, `lineItems.${line.id || line.qbLineId || "new"}.`, isNew || !matches.length);
    return { saved: { ...saved, ...line, ...mergedMetadata }, proposed: { ...saved, ...line, ...desired } };
  });
  next.lineItems = lines.map(line => line.saved);
  proposed.lineItems = lines.map(line => line.proposed);
  return { invoice: next, proposedInvoice: proposed, conflicts };
}

export function mergeInvoiceSpsMetadata(current, submitted, options) {
  return mergeInvoiceSpsMetadataResult(current, submitted, options).invoice;
}

// A notes/cost checkpoint may have editor-only pending flags. The database
// normalizes those flags while retaining confirmed accounting. Verify every
// other field, including all charges and the saved metadata, before accepting.
export function invoiceCheckpointMatches(candidate, confirmed) {
  if (!record(candidate) || !record(confirmed)) return false;
  if (sameValue(candidate, confirmed)) return true;
  if (!candidate.qbId || String(candidate.qbId) !== String(confirmed.qbId)
    || confirmed.qbAuthoritative !== true || confirmed.locallyEdited === true
    || confirmed.qbSyncStatus !== 'synced') return false;
  const comparable = invoice => Object.fromEntries(Object.entries(invoice).filter(([key]) =>
    !['locallyEdited','qbAuthoritative','qbPendingLocalEdits','qbLocalChangesPending','qbSyncStatus'].includes(key)));
  return sameValue(comparable(candidate), comparable(confirmed));
}
