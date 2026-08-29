import { isQuickBooksManagedInvoice } from "./invoiceBulkActions.js";

const text = (value) => String(value == null ? "" : value).trim();

export function parseInvoiceSequence(value) {
  const raw = text(value);
  const match = /^(.*?)(\d+)(\D*)$/.exec(raw);
  if (!match) return null;
  return {
    raw,
    prefix: match[1],
    suffix: match[3],
    digits: match[2].length,
    sequence: Number(match[2]),
    key: `${match[1]}{number}${match[3]}`,
  };
}

const formatInvoiceSequence = (parts, sequence) => (
  `${parts.prefix}${String(sequence).padStart(parts.digits, "0")}${parts.suffix}`
);

const hasEvidenceValue = (value) => {
  if (value == null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

const EXTERNAL_OR_CLIENT_EVIDENCE_FIELDS = Object.freeze([
  "sentDate", "sentAt", "emailedAt", "emailSentAt", "deliveredAt", "deliveryDate",
  "qbEmailStatus", "viewedAt", "clientViewedAt", "openedAt", "downloadedAt",
  "exportedAt", "printedAt", "sharedAt", "paymentLink", "paidDate", "paidAt",
  "payment", "payments", "paymentId", "paymentStatus",
]);

const LINKED_WORK_FIELDS = Object.freeze([
  "sourceEstimateId", "estimateId", "sourceStopId", "sourceStopIds", "stopId",
  "sourceVisitId", "sourceVisitIds", "sourceVisitClientId", "sourceVisitClientIds",
  "visitId", "linkedInvoiceId", "linkedScheduledStopId", "sourceReportId",
  "linkedReportId", "completionReceiptId", "autoDraftKey", "billingDisposition",
]);

const hasQuickBooksEvidence = (invoice) => Object.entries(invoice || {}).some(([key, value]) => (
  /^qb(?:[A-Z_]|$)/.test(key) && hasEvidenceValue(value)
));

export function draftInvoiceCanBeRenumbered(invoice, { protectedInvoiceIds = new Set() } = {}) {
  if (!invoice || typeof invoice !== "object") return false;
  if (protectedInvoiceIds.has(text(invoice.id))) return false;
  if (text(invoice.status).toLowerCase() !== "draft") return false;
  if (!parseInvoiceSequence(invoice.number)) return false;
  if (isQuickBooksManagedInvoice(invoice)) return false;
  if (hasQuickBooksEvidence(invoice)) return false;
  if (EXTERNAL_OR_CLIENT_EVIDENCE_FIELDS.some((key) => hasEvidenceValue(invoice[key]))) return false;
  if (LINKED_WORK_FIELDS.some((key) => hasEvidenceValue(invoice[key]))) return false;
  const origin = text(invoice.source || invoice.origin).toLowerCase();
  if (origin && !["local", "manual", "sps", "sps-way"].includes(origin)) return false;
  return true;
}

/**
 * Remove one invoice and close its number gap using only later, never-synced
 * drafts from the same configured number series. Customer-visible and
 * QuickBooks-managed numbers are treated as permanent accounting records.
 */
export function deleteInvoiceAndCompactSafeDrafts(invoices, invoiceId, {
  now = new Date().toISOString(),
  protectedInvoiceIds = new Set(),
} = {}) {
  const source = Array.isArray(invoices) ? invoices : [];
  const id = text(invoiceId);
  const deleted = source.find((invoice) => text(invoice?.id) === id) || null;
  const remaining = source.filter((invoice) => text(invoice?.id) !== id);
  const deletedParts = parseInvoiceSequence(deleted?.number);

  if (!deleted || !draftInvoiceCanBeRenumbered(deleted, { protectedInvoiceIds }) || !deletedParts) {
    return { invoices: remaining, deleted, renumbered: [], compacted: false };
  }

  const candidates = remaining
    .filter((invoice) => {
      const parts = parseInvoiceSequence(invoice?.number);
      return draftInvoiceCanBeRenumbered(invoice, { protectedInvoiceIds })
        && parts?.key === deletedParts.key
        && parts.sequence > deletedParts.sequence;
    })
    .sort((a, b) => parseInvoiceSequence(a.number).sequence - parseInvoiceSequence(b.number).sequence);

  if (!candidates.length) {
    return { invoices: remaining, deleted, renumbered: [], compacted: false };
  }

  const candidateIds = new Set(candidates.map((invoice) => text(invoice.id)));
  const protectedSequences = new Set(
    remaining
      .filter((invoice) => !candidateIds.has(text(invoice?.id)))
      .map((invoice) => parseInvoiceSequence(invoice?.number))
      .filter((parts) => parts?.key === deletedParts.key)
      .map((parts) => parts.sequence),
  );

  const replacements = new Map();
  const renumbered = [];
  let sequence = deletedParts.sequence;

  for (const invoice of candidates) {
    while (protectedSequences.has(sequence)) sequence += 1;
    const parts = parseInvoiceSequence(invoice.number);
    const nextNumber = formatInvoiceSequence(parts, sequence);
    if (nextNumber !== text(invoice.number)) {
      const nextInvoice = {
        ...invoice,
        number: nextNumber,
        draftNumberAdjustedAt: now,
        previousDraftNumber: text(invoice.number),
      };
      replacements.set(text(invoice.id), nextInvoice);
      renumbered.push({ id: text(invoice.id), from: text(invoice.number), to: nextNumber });
    }
    protectedSequences.add(sequence);
    sequence += 1;
  }

  return {
    invoices: remaining.map((invoice) => replacements.get(text(invoice?.id)) || invoice),
    deleted,
    renumbered,
    compacted: renumbered.length > 0,
  };
}
