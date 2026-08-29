import { isQuickBooksManagedInvoice } from "./invoiceBulkActions.js";

const text = (value) => String(value == null ? "" : value).trim();
const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toISODate = (value, fallback = "") => {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  return fallback;
};

export function quickBooksDraftSyncEligibility(invoice, client = null) {
  if (!text(invoice?.id)) return { eligible: false, reason: "Missing SPS invoice ID" };
  if (!text(invoice?.number)) return { eligible: false, reason: "Invoice number is missing" };
  if (text(invoice?.status).toLowerCase() !== "draft") return { eligible: false, reason: "Not a draft" };
  if (invoice?.qbSpsOnly === true || text(invoice?.qbSyncStatus).toLowerCase() === "sps-only") {
    return { eligible: false, reason: "Marked SPS-only" };
  }
  if (invoice?.qbCreateOutcomeUnknown || text(invoice?.qbSyncStatus).toLowerCase() === "create-outcome-unknown") {
    return { eligible: false, reason: "QuickBooks outcome needs review" };
  }
  if (invoice?.qbNeedsReview || invoice?.qbReviewRequired || invoice?.qbConflict) {
    return { eligible: false, reason: "QuickBooks review required" };
  }
  if (isQuickBooksManagedInvoice(invoice)) return { eligible: false, reason: "Already linked to QuickBooks" };
  if (!text(client?.name || invoice?.clientName)) return { eligible: false, reason: "Client is missing" };
  if (!Array.isArray(invoice?.lineItems) || !invoice.lineItems.length) return { eligible: false, reason: "No line items" };
  const meaningfulLines = invoice.lineItems.filter((line) => (
    text(line?.desc || line?.description)
    && number(line?.qty, 0) > 0
    && number(line?.unitPrice, 0) > 0
  ));
  if (!meaningfulLines.length) return { eligible: false, reason: "No billable line items" };
  return { eligible: true, reason: "" };
}

export function partitionQuickBooksDraftSelection(invoices, resolveClient = () => null) {
  const ready = [];
  const skipped = [];
  for (const invoice of Array.isArray(invoices) ? invoices : []) {
    const client = resolveClient(invoice) || null;
    const eligibility = quickBooksDraftSyncEligibility(invoice, client);
    const row = { invoice, client, ...eligibility };
    if (eligibility.eligible) ready.push(row);
    else skipped.push(row);
  }
  return { ready, skipped };
}

export function buildQuickBooksInvoicePayload(invoice, client, invoicing, { today = new Date() } = {}) {
  const fallbackDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return {
    spsInvoiceId: invoice?.id,
    number: invoice?.number,
    date: toISODate(invoice?.date, fallbackDate),
    dueDate: toISODate(invoice?.dueDate),
    clientName: client?.name || invoice?.clientName || "",
    clientEmail: client?.email || invoice?.clientEmail || "",
    clientPhone: client?.phone || invoice?.clientPhone || "",
    clientAddress: client?.address || invoice?.clientAddress || "",
    clientStreet: client?.street || invoice?.clientStreet || "",
    clientCity: client?.city || invoice?.clientCity || "",
    clientState: client?.state || invoice?.clientState || "",
    clientZip: client?.zip || invoice?.clientZip || "",
    qbCustomerId: client?.qbId || client?.qbCustomerId || invoice?.qbCustomerId || null,
    qbId: invoice?.qbId || null,
    qbBaseContentFingerprint: invoice?.qbBaseContentFingerprint || invoice?.qbContentFingerprint || "",
    qbTaxCodeRef: invoice?.qbTaxCodeRef || null,
    taxRate: number(invoice?.taxRate),
    allowCard: invoicing?.qbManagePayments === false ? invoicing?.qbAllowCard !== false : undefined,
    allowACH: invoicing?.qbManagePayments === false ? invoicing?.qbAllowACH !== false : undefined,
    lineItems: (invoice?.lineItems || []).map((line) => {
      const qty = number(line?.qty, 1) || 1;
      const gross = number(line?.qty) * number(line?.unitPrice);
      const discount = line?.discountType === "pct"
        ? gross * (number(line?.discount) / 100)
        : line?.discountType === "amt" ? number(line?.discount) : 0;
      const net = Math.max(0, gross - discount);
      return {
        description: line?.bundleNote ? `${line?.desc || ""} (${line.bundleNote})` : (line?.desc || ""),
        qty: String(qty),
        unitPrice: String(qty > 0 ? (net / qty).toFixed(2) : net.toFixed(2)),
        kind: line?.isLateFee ? "lateFee" : (line?.kind || "custom"),
        taxable: !!line?.taxable,
        isLateFee: !!line?.isLateFee,
        qbLineId: line?.qbLineId || null,
        qbItemRef: line?.qbItemRef || null,
      };
    }),
    invoiceDiscountType: invoice?.discountType || "",
    invoiceDiscount: invoice?.discount || "",
  };
}
