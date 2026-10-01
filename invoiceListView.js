const text = (value) => typeof value === "string" || typeof value === "number"
  ? String(value).replace(/\s+/g, " ").trim()
  : "";
const normalized = (value) => text(value).normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const collator = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });

export const INVOICE_LIST_SORT_OPTIONS = Object.freeze([
  ["number_desc", "Invoice number: high to low"], ["number_asc", "Invoice number: low to high"],
  ["description_asc", "Description: A to Z"], ["description_desc", "Description: Z to A"],
  ["client_asc", "Client: A to Z"], ["client_desc", "Client: Z to A"],
  ["date_desc", "Issued: newest first"], ["date_asc", "Issued: oldest first"],
  ["due_asc", "Due: earliest first"], ["due_desc", "Due: latest first"],
  ["amount_desc", "Amount: high to low"], ["amount_asc", "Amount: low to high"],
  ["status_asc", "Status: A to Z"], ["status_desc", "Status: Z to A"],
].map(([value, label]) => Object.freeze({ value, label })));

function lineDescriptions(invoice) {
  // The editable SPS lines are authoritative even when deliberately empty.
  // QuickBooks sync also saves a legacy lines snapshot which may now be stale.
  const lines = Array.isArray(invoice?.lineItems) ? invoice.lineItems
    : Array.isArray(invoice?.lines) ? invoice.lines
      : Array.isArray(invoice?.items) ? invoice.items
        : Array.isArray(invoice?.Line) ? invoice.Line : [];
  return lines.flatMap((line) => {
    if (!line || typeof line !== "object") return [];
    if (["SubTotalLineDetail", "DiscountLineDetail", "TaxLineDetail"].includes(line.DetailType)) return [];
    const description = text(line.desc) || text(line.description) || text(line.Description)
      || text(line.name) || text(line.qbItemRef?.name) || text(line.SalesItemLineDetail?.ItemRef?.name);
    const bundle = text(line.bundleNote);
    if (!bundle || normalized(description).includes(normalized(bundle))) return description ? [description] : [];
    return [description ? `${description} (${bundle})` : bundle];
  });
}

/** Full source-authored title and line descriptions, suitable for CSS truncation. */
export function invoiceDescription(invoice) {
  const seen = new Set();
  return [text(invoice?.title), text(invoice?.description), ...lineDescriptions(invoice)].filter((description) => {
    const key = normalized(description);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(" · ");
}

function clientName(invoice) {
  return text(invoice?._client?.name) || text(invoice?.clientName) || text(invoice?.CustomerRef?.name);
}

/** Search every source line, not just the visually truncated first line. */
export function invoiceMatchesSearch(invoice, search) {
  const terms = normalized(search).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const content = normalized([
    text(invoice?.number) || text(invoice?.DocNumber), clientName(invoice), invoiceDescription(invoice),
  ].join(" "));
  return terms.every((term) => content.includes(term));
}

/** Parse invoice calendar dates in local time, rejecting impossible dates. */
export function invoiceListDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  const raw = text(value);
  let year;
  let month;
  let day;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(raw);
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (iso) {
    if (raw.includes("T") && !Number.isFinite(Date.parse(raw))) return null;
    [, year, month, day] = iso.map(Number);
  } else if (mdy) {
    [, month, day, year] = mdy.map(Number);
  } else return null;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function finiteAmount(value) {
  if (value == null || text(value) === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sortValue(invoice, key) {
  if (key === "description") return invoiceDescription(invoice) || null;
  if (key === "client") return clientName(invoice) || null;
  if (key === "status") return text(invoice?._status || invoice?.status) || null;
  if (key === "amount") return finiteAmount(invoice?._total ?? invoice?.total ?? invoice?.TotalAmt);
  if (key === "due") return invoiceListDate(invoice?.dueDate ?? invoice?.DueDate)?.getTime() ?? null;
  if (key === "date") {
    // An explicit but malformed issued date stays unknown instead of silently
    // sorting by a payment/created date supplied in an enriched fallback.
    const explicitDate = invoice?.date ?? invoice?.TxnDate;
    return invoiceListDate(text(explicitDate) ? explicitDate : invoice?._date)?.getTime() ?? null;
  }
  return text(invoice?.number) || text(invoice?.DocNumber) || null;
}

/**
 * Shared table/mobile ordering. Operates after existing status/date/client
 * filters so their behavior and bulk-selection membership remain unchanged.
 * Missing data stays last in both directions; ties use number then ID.
 */
export function sortInvoiceList(items, sortBy = "number_desc") {
  const parts = /^(number|description|client|date|due|amount|status)_(asc|desc)$/.exec(sortBy);
  const key = parts?.[1] || "number";
  const direction = parts?.[2] === "asc" ? 1 : -1;
  return (Array.isArray(items) ? [...items] : []).sort((left, right) => {
    const a = sortValue(left, key);
    const b = sortValue(right, key);
    if (a == null && b != null) return 1;
    if (a != null && b == null) return -1;
    const comparison = a == null && b == null ? 0
      : typeof a === "number" && typeof b === "number" ? a - b : collator.compare(a, b);
    return comparison * direction
      || collator.compare(text(left?.number || left?.DocNumber), text(right?.number || right?.DocNumber))
      || collator.compare(text(left?.id || left?.qbId), text(right?.id || right?.qbId));
  });
}
