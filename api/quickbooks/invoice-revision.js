import { createHash } from "node:crypto";

// Customer-facing QuickBooks invoice content that an SPS full update can replace.
// Deliberately excluded: SyncToken, MetaData, Balance, TotalAmt, EmailStatus,
// DeliveryInfo, LinkedTxn, and InvoiceLink. Those values can change because of a
// payment or delivery without somebody editing the invoice itself.
const CONTENT_FIELDS = [
  "CustomerRef",
  "DocNumber",
  "TxnDate",
  "DueDate",
  "BillEmail",
  "BillAddr",
  "ShipAddr",
  "CustomerMemo",
  "PrivateNote",
  "SalesTermRef",
  "DepartmentRef",
  "ClassRef",
  "CurrencyRef",
  "ExchangeRate",
  "ApplyTaxAfterDiscount",
  "GlobalTaxCalculation",
  "TxnTaxDetail",
  "Line",
  "Deposit",
  "AllowOnlineCreditCardPayment",
  "AllowOnlineACHPayment",
];

function canonicalize(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (typeof value !== "object") return String(value);

  const result = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = canonicalize(value[key]);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

export function normalizeQuickBooksInvoiceContent(invoice) {
  const source = invoice && typeof invoice === "object" ? invoice : {};
  const content = { schemaVersion: 1 };
  for (const field of CONTENT_FIELDS) {
    if (source[field] !== undefined) content[field] = source[field];
  }
  return canonicalize(content);
}

export function fingerprintQuickBooksInvoiceSnapshot(snapshot) {
  const canonical = JSON.stringify(canonicalize(snapshot && typeof snapshot === "object" ? snapshot : {}));
  return createHash("sha256").update(canonical).digest("hex");
}

export function fingerprintQuickBooksInvoiceContent(invoice) {
  return fingerprintQuickBooksInvoiceSnapshot(normalizeQuickBooksInvoiceContent(invoice));
}

export function quickBooksBaseFingerprint(invoice) {
  const direct = [
    invoice?.qbBaseContentFingerprint,
    invoice?.qbBaseFingerprint,
    invoice?.qbBaseContentHash,
    invoice?.qbContentFingerprint,
    invoice?.qbContentHash,
  ].find((value) => typeof value === "string" && value.trim());
  if (direct) return direct.trim().toLowerCase();
  if (invoice?.qbBaseSnapshot && typeof invoice.qbBaseSnapshot === "object") {
    return fingerprintQuickBooksInvoiceSnapshot(invoice.qbBaseSnapshot);
  }
  return "";
}

export function quickBooksInvoiceCreateRequestId(realmId, requestKey) {
  return `sps-${createHash("sha256")
    .update(`${realmId}:invoice-create:${requestKey}`)
    .digest("hex")
    .slice(0, 40)}`;
}
