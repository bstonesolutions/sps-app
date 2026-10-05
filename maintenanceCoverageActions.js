import { maintenanceInvoicePaymentStatus, maintenanceInvoiceTotalCents, moneyToCents } from "./maintenancePaymentLedger.js";

const text = value => String(value == null ? "" : value).trim();
const nameKey = value => text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
const list = value => Array.isArray(value) ? value : [];

export function maintenanceCoverageInvoiceChoices(clientId, clients, invoices) {
  const client = list(clients).find(candidate => text(candidate.id) === text(clientId));
  if (!client) return [];
  const clientName = nameKey(client.name);
  return list(invoices).filter(invoice => {
    const directId = text(invoice.clientId ?? invoice.customerId);
    if (directId) return directId === text(clientId);
    const qbId = text(invoice.qbCustomerId || invoice.CustomerRef?.value);
    if (qbId) {
      const owners = list(clients).filter(candidate => text(candidate.qbId || candidate.qbCustomerId) === qbId);
      return owners.length === 1 && text(owners[0].id) === text(clientId);
    }
    return !!clientName && nameKey(invoice.clientName || invoice.customerName || invoice.CustomerRef?.name) === clientName
      && list(clients).filter(candidate => nameKey(candidate.name) === clientName).length === 1;
  }).sort((left, right) => String(right.date || right.createdAt || right.TxnDate || "").localeCompare(String(left.date || left.createdAt || left.TxnDate || "")));
}

export function maintenanceCoverageInvoicePreview(invoice, monthKeys = []) {
  if (!invoice) return null;
  const status = maintenanceInvoicePaymentStatus(invoice);
  const totalCents = maintenanceInvoiceTotalCents(invoice, { unknownAsNull: true });
  const balance = invoice.balance ?? invoice.Balance;
  const balanceCents = balance == null || text(balance) === "" ? null : moneyToCents(balance);
  const label = { paid: "Paid", due: "Invoice open", partial: "Partly paid", refunded: "Refunded", review: "Needs review" }[status] || "Needs review";
  return { status, label, totalCents, balanceCents, monthCount: monthKeys.length };
}

export function maintenanceCoverageSavedMessage(ledger, clientId, monthKeys = []) {
  const labels = monthKeys.map(month => {
    const cell = ledger?.allocations?.[text(clientId)]?.[month];
    const manual = list(cell?.sources).find(source => source.kind === "manual");
    const label = manual?.decision === "unpaid" ? "Unpaid"
      : manual?.decision === "paid" ? "Paid, recorded by you"
      : { paid: "Paid", due: "Invoice open", partial: "Partly paid", waived: "Waived", review: "Needs review", refunded: "Refunded" }[cell?.status];
    return label ? `${new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`))}: ${label}` : "";
  }).filter(Boolean);
  return labels.length === monthKeys.length && labels.length ? `Saved. ${labels.join("; ")}.` : "Saved. The calendar has been updated.";
}
