import { maintenanceInvoicePaymentStatus, maintenanceInvoiceTotalCents } from "./maintenancePaymentLedger.js";

// Prepaid policies cover whole months. Store exact date boundaries while the
// editor asks for months, so a valid calendar choice cannot fail normalization.
export function maintenanceCoverageMonthDate(rawMonth, end = false) {
  const match = String(rawMonth || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1 || month < 1 || month > 12) return "";
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${match[1]}-${match[2]}-${end ? days[month - 1] : "01"}`;
}

function prepaymentInvoiceDetails(invoice) {
  const cents = maintenanceInvoiceTotalCents(invoice, { unknownAsNull: true });
  const amount = cents == null ? "Total not available" : `$${(cents / 100).toFixed(2)}`;
  const status = cents == null ? "Payment status unknown" : ({
    paid: "Paid",
    partial: "Partly paid",
    due: "Unpaid",
    review: "Payment status unknown",
    refunded: "Voided or refunded",
  }[maintenanceInvoicePaymentStatus(invoice)] || "Payment status unknown");
  return {
    number: invoice.number || invoice.DocNumber || "Unnumbered",
    date: invoice.date || invoice.TxnDate || "No date",
    amount,
    status,
  };
}

export function prepaymentInvoiceLabel(invoice) {
  const { number, date, amount, status } = prepaymentInvoiceDetails(invoice);
  return `Invoice ${number} · ${date} · ${amount} · ${status}`;
}

export function prepaymentInvoiceSummary(invoice) {
  const { date, amount, status } = prepaymentInvoiceDetails(invoice);
  return `${status} · ${amount} · ${date}`;
}
