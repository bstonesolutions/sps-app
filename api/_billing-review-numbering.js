import { getValidAccessToken, QB_API_BASE } from "./quickbooks/qb-store.js";

const text = value => String(value ?? "").trim();

export function sameInvoiceNumber(left, right) {
  const a = text(left), b = text(right);
  if (!a || !b) return false;
  const sequence = value => Number.parseInt(value.replace(/\D/g, ""), 10);
  const n = sequence(a);
  return a.toLowerCase() === b.toLowerCase() || (Number.isSafeInteger(n) && n === sequence(b));
}

export function normalizeBillingReviewInvoiceNumber(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9 ._/-]{0,19}[A-Za-z0-9])?$/.test(number) || number.toUpperCase() === "AUTO_GENERATE") {
    throw Object.assign(new Error("Use an invoice number of 1 to 21 characters, with letters, numbers, spaces, hyphens, periods, slashes or underscores."), { status: 422, code: "billing_review_number_invalid" });
  }
  return number;
}

export function billingReviewInvoiceNumberChoices(numbers, config = {}) {
  const claimed = [...numbers];
  const availableNumbers = [];
  for (let index = 0; index < 20; index += 1) {
    const next = firstUnusedInvoiceNumber(claimed, config);
    normalizeBillingReviewInvoiceNumber(next);
    availableNumbers.push(next); claimed.push(next);
  }
  let highestNumber = null, highestInvoiceNumber = null;
  for (const candidate of numbers) {
    const sequence = Number.parseInt(text(candidate).replace(/\D/g, ""), 10);
    if (Number.isSafeInteger(sequence) && (highestNumber == null || sequence > highestNumber)) {
      highestNumber = sequence; highestInvoiceNumber = text(candidate);
    }
  }
  return { nextNumber: availableNumbers[0], availableNumbers, highestNumber, highestInvoiceNumber };
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 1000;
// QuickBooks has no column selection, so each page carries full invoices. Fetch the
// counted pages a few at a time instead of one after another, under its per-company
// concurrency limit.
const PARALLEL_PAGES = 4;

// No status filter: QuickBooks retains void invoices and their DocNumbers.
// Stop only at the end of the complete collection; a failed page is not an empty page.
export async function readQuickBooksInvoiceNumberInventory() {
  const { access_token, realm_id } = await getValidAccessToken();
  const query = async statement => {
    const response = await fetch(`${QB_API_BASE}/v3/company/${encodeURIComponent(realm_id)}/query?query=${encodeURIComponent(statement)}&minorversion=65`, {
      headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("QuickBooks invoice numbers could not be checked. No invoice was created.");
    const data = await response.json();
    if (data?.Fault || !data?.QueryResponse || (data.QueryResponse.Invoice != null && !Array.isArray(data.QueryResponse.Invoice))) {
      throw new Error("QuickBooks returned an incomplete invoice inventory. No invoice was created.");
    }
    return data.QueryResponse;
  };
  const page = async index => (await query(`SELECT * FROM Invoice STARTPOSITION ${index * PAGE_SIZE + 1} MAXRESULTS ${PAGE_SIZE}`)).Invoice || [];
  const total = Number((await query("SELECT COUNT(*) FROM Invoice")).totalCount);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("QuickBooks returned an incomplete invoice inventory. No invoice was created.");
  // The page after the count must come back short; one created mid-scan is read below.
  const counted = Math.floor(total / PAGE_SIZE) + 1;
  if (counted > MAX_PAGES) throw new Error("QuickBooks invoice inventory exceeded the verification limit.");
  const pages = [];
  for (let start = 0; start < counted; start += PARALLEL_PAGES) {
    pages.push(...await Promise.all(Array.from({ length: Math.min(PARALLEL_PAGES, counted - start) }, (_, offset) => page(start + offset))));
  }
  while (pages.at(-1).length >= PAGE_SIZE) {
    if (pages.length >= MAX_PAGES) throw new Error("QuickBooks invoice inventory exceeded the verification limit.");
    pages.push(await page(pages.length));
  }
  const numbers = new Set();
  const ids = new Set();
  for (const row of pages.flat()) {
    if (!text(row.Id) || ids.has(text(row.Id))) throw new Error("QuickBooks invoice pagination could not be verified.");
    ids.add(text(row.Id));
    if (text(row.DocNumber)) numbers.add(text(row.DocNumber));
  }
  return { realmId: text(realm_id), numbers: [...numbers], invoiceCount: ids.size, checkedAt: new Date().toISOString() };
}

export function firstUnusedInvoiceNumber(numbers, config = {}) {
  const start = Number.parseInt(config.nextNumber, 10) || 1001;
  if (!Number.isSafeInteger(start) || start < 1) throw new Error("The invoice starting number is invalid.");
  const prefix = config.numberPrefix == null ? "INV-" : String(config.numberPrefix);
  // Match legacy bare and prefixed representations conservatively. Never reuse a
  // numeric sequence simply because another system formatted its prefix differently.
  const sequences = new Set(numbers.map(value => Number.parseInt(text(value).replace(/\D/g, ""), 10)).filter(Number.isSafeInteger));
  const exact = new Set(numbers.map(value => text(value).toLowerCase()));
  for (let sequence = start; Number.isSafeInteger(sequence); sequence += 1) {
    const candidate = `${prefix}${sequence}`;
    if (!sequences.has(sequence) && !exact.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error("No available invoice number could be confirmed.");
}
