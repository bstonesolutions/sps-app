import { invoiceMaintenanceCoverageIssue } from "./maintenanceInvoiceCoverage.js";
import { normalizeMaintenancePaymentLedger } from "./maintenancePaymentLedger.js";

export function invoiceDeliveryIdentity(invoice, clientId) {
  const keys = ["id", "qbId", "qbCustomerId", "source", "autoPeriod", "serviceMonth", "sourceStopId", "sourceStopIds", "sourceCompletionReceiptId", "sourceCompletionReceiptIds", "invoiceDiscountType", "invoiceDiscount"];
  return {
    ...Object.fromEntries(keys.filter(key => invoice?.[key] != null).map(key => [key, invoice[key]])),
    spsInvoiceId: invoice?.id || "",
    clientId: clientId ?? invoice?.clientId ?? "",
  };
}

export function invoiceDeliveryLine(line) {
  const keys = ["id", "qbLineId", "kind", "desc", "description", "qty", "unitPrice", "bundleNote", "taxable", "sourceStopId", "sourceStopIds", "sourceCompletionReceiptId", "sourceCompletionReceiptIds"];
  return Object.fromEntries(keys.filter(key => line?.[key] != null).map(key => [key, line[key]]));
}

// Called before constructing or sending any channel. A failed preflight must
// not send a text/portal notice while the email is held for billing review.
export async function assertInvoiceDeliveryCoverage({ invoice, client, clients = [], invoices = [], schedule = [], loadLedger }) {
  const options = { invoice, client: client || { id: "unresolved", history: [] }, clients, invoices, schedule };
  if (!invoiceMaintenanceCoverageIssue({ ...options, ledger: null })) return;
  let ledger;
  try { ledger = normalizeMaintenancePaymentLedger(await loadLedger()); } catch (_) {}
  if (!ledger) {
    const error = new Error("Payment coverage could not be checked. No invoice messages were sent. Try again.");
    error.code = "maintenance-coverage-unavailable";
    throw error;
  }
  if (!client?.id) throw new Error("Select a verified client before sending this maintenance invoice.");
  const issue = invoiceMaintenanceCoverageIssue({ ...options, ledger });
  if (issue) {
    const error = new Error(`${issue.message} No invoice messages were sent.`);
    error.code = issue.code;
    throw error;
  }
}
