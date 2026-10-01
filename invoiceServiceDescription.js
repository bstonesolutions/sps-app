import { invoiceListDate } from "./invoiceListView.js";
import { isMaintenanceServiceLine } from "./maintenanceServiceLine.js";

const text = (value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const lines = (invoice) => Array.isArray(invoice?.lineItems) ? invoice.lineItems
  : Array.isArray(invoice?.items) ? invoice.items : [];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_PATTERN = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const monthNumber = (name) => MONTH_NAMES.findIndex((month) => month.toLowerCase().startsWith(text(name).slice(0, 3).toLowerCase())) + 1;
const monthKey = (year, month) => Number(year) >= 1900 && Number(year) <= 2200 && Number(month) >= 1 && Number(month) <= 12
  ? `${year}-${String(month).padStart(2, "0")}` : "";
const unique = (values) => [...new Set(values)].sort();
const equalMonths = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const descriptionOf = (line) => text(line?.desc || line?.description || line?.name);

function metadataMonth(value) {
  const raw = text(value);
  const month = /^(\d{4})-(\d{2})$/.exec(raw);
  if (month) return monthKey(month[1], month[2]);
  const date = invoiceListDate(raw);
  return date ? monthKey(date.getFullYear(), date.getMonth() + 1) : "";
}

function expandRange(start, end) {
  if (!start || !end || start > end) return [];
  let [year, month] = start.split("-").map(Number);
  const result = [];
  while (monthKey(year, month) <= end && result.length < 120) {
    result.push(monthKey(year, month));
    month += 1;
    if (month > 12) { year += 1; month = 1; }
  }
  return result;
}

function descriptionEvidence(description) {
  const months = [];
  let invalid = false;
  const namedRange = new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s*(?:(\\d{4})\\s*)?(?:-|–|—|to|through)\\s*(${MONTH_PATTERN})\\.?\\s+(\\d{4})\\b`, "gi");
  for (const match of description.matchAll(namedRange)) {
    const start = monthKey(match[2] || match[4], monthNumber(match[1]));
    const end = monthKey(match[4], monthNumber(match[3]));
    const range = expandRange(start, end);
    if (!range.length) invalid = true;
    months.push(...range);
  }
  const namedList = new RegExp(`\\b(${MONTH_PATTERN}(?:\\s*(?:,|and|&)\\s*${MONTH_PATTERN})+)\\.?\\s+(\\d{4})\\b`, "gi");
  for (const match of description.matchAll(namedList)) {
    for (const name of match[1].matchAll(new RegExp(MONTH_PATTERN, "gi"))) months.push(monthKey(match[2], monthNumber(name[0])));
  }
  const named = new RegExp(`\\b(${MONTH_PATTERN})\\.?(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?)?[\\s,-]+(\\d{4})\\b`, "gi");
  for (const match of description.matchAll(named)) {
    const key = monthKey(match[3], monthNumber(match[1]));
    if (!key || (match[2] && !invoiceListDate(`${key}-${String(match[2]).padStart(2, "0")}`))) invalid = true;
    else months.push(key);
  }
  for (const match of description.matchAll(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g)) {
    const key = match[3] ? metadataMonth(match[0]) : monthKey(match[1], match[2]);
    if (key) months.push(key); else invalid = true;
  }
  for (const match of description.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const key = metadataMonth(match[0]);
    if (key) months.push(key); else invalid = true;
  }
  for (const match of description.matchAll(/(?<![\d/])(\d{1,2})\/(\d{4})(?![\d/])/g)) {
    const key = monthKey(match[2], match[1]);
    if (key) months.push(key); else invalid = true;
  }
  const numericDate = "(?:\\d{4}-\\d{2}(?:-\\d{2})?|\\d{1,2}/\\d{1,2}/\\d{4})";
  for (const match of description.matchAll(new RegExp(`\\b(${numericDate})\\s*(?:-|–|—|to|through)\\s*(${numericDate})\\b`, "g"))) {
    const range = expandRange(metadataMonth(match[1]), metadataMonth(match[2]));
    if (!range.length) invalid = true;
    months.push(...range);
  }
  return {
    months: unique(months.filter(Boolean)),
    monthNames: [...new Set([...description.matchAll(new RegExp(`\\b(${MONTH_PATTERN})\\.?\\b`, "gi"))].map((match) => monthNumber(match[1])))],
    invalid,
  };
}

function fieldEvidence(source, includeVisitDates) {
  const sets = [];
  let invalid = false;
  for (const key of includeVisitDates ? ["serviceMonth", "serviceDate"] : ["serviceMonth", "autoPeriod"]) {
    if (!text(source?.[key])) continue;
    const month = metadataMonth(source[key]);
    if (month) sets.push([month]); else invalid = true;
  }
  if (includeVisitDates && source?.sourceVisitDates != null) {
    if (!Array.isArray(source.sourceVisitDates)) invalid = true;
    else if (source.sourceVisitDates.length) {
      const months = source.sourceVisitDates.map(metadataMonth);
      if (months.some((month) => !month)) invalid = true;
      else sets.push(unique(months));
    }
  }
  if (sets.some((months) => !equalMonths(months, sets[0]))) invalid = true;
  return { months: sets[0] || [], invalid };
}

function lineEvidence(invoice, line) {
  if (!isMaintenanceServiceLine(invoice, line)) return { months: [], applicable: false };
  const description = descriptionEvidence(descriptionOf(line));
  const explicit = fieldEvidence(line, true);
  const fallback = !explicit.months.length && !description.months.length ? fieldEvidence(invoice, false) : { months: [], invalid: false };
  const months = explicit.months.length ? explicit.months : description.months.length ? description.months : fallback.months;
  const conflict = explicit.invalid || fallback.invalid || description.invalid
    || (explicit.months.length && description.months.length && !equalMonths(explicit.months, description.months))
    || (months.length && description.monthNames.some((month) => !months.some((key) => Number(key.slice(5)) === month)));
  return { applicable: true, months: conflict ? [] : months, conflict: !!conflict, descriptionHasMonths: description.months.length > 0 };
}

export function invoiceHasMaintenanceServiceLines(invoice) {
  return lines(invoice).some((line) => isMaintenanceServiceLine(invoice, line));
}

/** Verified service months only. Never falls back to invoice, due, or current date. */
export function invoiceServiceLineMonths(invoice, line) {
  return lineEvidence(invoice, line).months;
}

export function invoiceServiceDescriptionIssue(invoice) {
  const missing = [];
  const conflicts = [];
  lines(invoice).forEach((line, index) => {
    const evidence = lineEvidence(invoice, line);
    if (!evidence.applicable) return;
    if (evidence.conflict) conflicts.push(index);
    else if (!evidence.months.length) missing.push(index);
  });
  if (!conflicts.length && !missing.length) return null;
  const conflict = conflicts.length > 0;
  const indexes = unique([...conflicts, ...missing]).map(Number).sort((a, b) => a - b);
  return {
    code: conflict ? "maintenance-service-month-conflict" : "maintenance-service-month-missing",
    message: conflict
      ? "The maintenance description and service dates do not agree. Review the service month and line descriptions before sending to QuickBooks."
      : "Choose the month and year when this maintenance was performed before sending to QuickBooks. The invoice issue date does not set the service month.",
    lineIndexes: indexes,
  };
}

export function formatInvoiceServiceLineDescription(invoice, line) {
  const original = descriptionOf(line);
  const evidence = lineEvidence(invoice, line);
  // Validation owns blocking. Formatting must remain safe for old saved records
  // used in revision fingerprints and previews, without throwing or inventing dates.
  if (!evidence.applicable || evidence.conflict || !evidence.months.length || evidence.descriptionHasMonths) return original;
  if (evidence.months.length === 1) {
    const [year, month] = evidence.months[0].split("-").map(Number);
    const trailingMonth = new RegExp(`\\b(${MONTH_PATTERN})\\.?$`, "i");
    const match = trailingMonth.exec(original);
    if (match && monthNumber(match[1]) === month) return `${original} ${year}`;
  }
  const labels = evidence.months.map((key) => `${MONTH_NAMES[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`);
  return `${original || "Monthly service"} - ${labels.join(", ")}`;
}
