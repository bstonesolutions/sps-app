import { maintenancePaymentDisplayStatus, normalizeMonthKey } from "./maintenancePaymentLedger.js";

const options = (entries) => Object.freeze(entries.map(([value, label]) => Object.freeze({ value, label })));

export const MAINTENANCE_CALENDAR_SERVICE_OPTIONS = options([
  ["all", "All services"],
  ["pool", "Pool"],
  ["pond", "Pond"],
  ["leaf", "Leaf"],
]);

export const MAINTENANCE_CALENDAR_PAYMENT_OPTIONS = options([
  ["all", "All payment statuses"],
  ["paid", "Paid or prepaid"],
  ["unpaid", "Unpaid"],
  ["prepaid", "Prepaid"],
  ["partial", "Partly paid"],
  ["open", "Invoice open"],
  ["missing", "No matching payment"],
  ["review", "Needs review"],
  ["waived", "Waived"],
  ["upcoming", "Upcoming"],
]);

const PAYMENT_FILTERS = new Set(MAINTENANCE_CALENDAR_PAYMENT_OPTIONS.map((option) => option.value));
const SERVICE_FILTERS = new Set(MAINTENANCE_CALENDAR_SERVICE_OPTIONS.map((option) => option.value));
const UNPAID_STATUSES = new Set(["due", "partial", "missing", "refunded"]);
const KNOWN_STATUS_ORDER = new Map([
  ["due", 0], ["partial", 1], ["missing", 2], ["refunded", 3],
  ["paid", 4], ["prepaid", 5], ["waived", 6],
]);
const INACTIVE_STATUS_ORDER = new Map([["upcoming", 0], ["not_expected", 1]]);
const nameCollator = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });
const text = (value) => String(value == null ? "" : value).trim();
const normalizedSearch = (value) => text(value).normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const currentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};
const validMonthKeys = (keys) => [...new Set((Array.isArray(keys) ? keys : [])
  .map(normalizeMonthKey).filter(Boolean))];

function scopeMonthKeys(rows, { monthKey, monthKeys } = {}) {
  const selectedMonth = normalizeMonthKey(monthKey);
  if (selectedMonth) return [selectedMonth];
  if (Array.isArray(monthKeys)) return validMonthKeys(monthKeys);
  return validMonthKeys(rows.flatMap((row) => Object.keys(row?.byMonth || {}))).sort();
}

function paymentStatus(row, monthKey, asOfMonth) {
  return maintenancePaymentDisplayStatus(row?.byMonth?.[monthKey]?.payment?.status, monthKey, asOfMonth);
}

function statusMatches(row, month, filter, asOfMonth) {
  const status = paymentStatus(row, month, asOfMonth);
  if (filter === "paid") return status === "paid" || status === "prepaid";
  // A future month's charge is not an overdue/unpaid maintenance obligation yet.
  // Explicit future invoices still remain discoverable under Invoice open or Partly paid.
  if (filter === "unpaid") return month <= asOfMonth && UNPAID_STATUSES.has(status);
  if (filter === "open") return status === "due";
  if (filter === "review") {
    return !KNOWN_STATUS_ORDER.has(status) && !INACTIVE_STATUS_ORDER.has(status);
  }
  return status === filter;
}

export function maintenanceCalendarPrepaidCount(row, monthKeys) {
  const months = Array.isArray(monthKeys)
    ? validMonthKeys(monthKeys)
    : validMonthKeys(Object.keys(row?.byMonth || {}));
  return months.filter((month) => text(row?.byMonth?.[month]?.payment?.status).toLowerCase() === "prepaid").length;
}

function priceValue(row) {
  const raw = Object.prototype.hasOwnProperty.call(row || {}, "maintenancePriceCents")
    ? row.maintenancePriceCents
    : row?.expectedMonthlyCents;
  if (raw == null || text(raw) === "" || typeof raw === "boolean") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function monthSortValue(row, month, asOfMonth) {
  const status = paymentStatus(row, month, asOfMonth);
  const futureUnpaid = month > asOfMonth && UNPAID_STATUSES.has(status);
  if (INACTIVE_STATUS_ORDER.has(status) || futureUnpaid) {
    return { group: 2, rank: futureUnpaid ? 0 : INACTIVE_STATUS_ORDER.get(status) };
  }
  if (!KNOWN_STATUS_ORDER.has(status)) return { group: 1, rank: 0 };
  return { group: 0, rank: KNOWN_STATUS_ORDER.get(status) };
}

function compareNames(left, right) {
  return nameCollator.compare(text(left?.clientName), text(right?.clientName))
    || nameCollator.compare(text(left?.clientId), text(right?.clientId));
}

/**
 * Read-only calendar query. A status matches any month in the visible scope, or
 * just monthKey when one is selected. "Paid" includes prepayments; "Unpaid"
 * excludes future months and uncertain history. Waived months are not paid.
 *
 * Month ascending order is open, partial, missing, refunded, paid, prepaid,
 * waived. Descending reverses those known statuses. Uncertain history follows
 * known statuses, then upcoming/no-service cells, in BOTH directions.
 * Missing prices likewise stay last; zero is a valid price. Every tie falls
 * back to client name and ID ascending, without mutating rows or their cells.
 */
export function filterMaintenanceCalendarRows(rows, {
  search = "",
  serviceType = "all",
  paymentStatus: requestedPaymentStatus = "all",
  monthKey = "all",
  monthKeys,
  sortKey = "name",
  sortDirection = "asc",
  asOfMonth,
} = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const query = normalizedSearch(search);
  const service = SERVICE_FILTERS.has(serviceType) ? serviceType : "all";
  const filter = PAYMENT_FILTERS.has(requestedPaymentStatus) ? requestedPaymentStatus : "all";
  const comparisonMonth = normalizeMonthKey(asOfMonth) || currentMonth();
  const scopedMonths = scopeMonthKeys(sourceRows, { monthKey, monthKeys });
  const prepaidMonths = Array.isArray(monthKeys) ? validMonthKeys(monthKeys) : undefined;
  const direction = sortDirection === "desc" ? -1 : 1;
  const sortedMonth = normalizeMonthKey(sortKey);

  return sourceRows.filter((row) => {
    if (!row || typeof row !== "object") return false;
    if (query && !normalizedSearch(row.clientName).includes(query)) return false;
    if (service !== "all" && !(Array.isArray(row.maintenanceTypes) && row.maintenanceTypes.includes(service))) return false;
    return filter === "all" || scopedMonths.some((month) => statusMatches(row, month, filter, comparisonMonth));
  }).sort((left, right) => {
    let comparison = 0;
    if (sortKey === "price") {
      const leftPrice = priceValue(left);
      const rightPrice = priceValue(right);
      if (leftPrice == null && rightPrice != null) return 1;
      if (rightPrice == null && leftPrice != null) return -1;
      comparison = (leftPrice ?? 0) - (rightPrice ?? 0);
    } else if (sortKey === "prepaid") {
      comparison = maintenanceCalendarPrepaidCount(left, prepaidMonths) - maintenanceCalendarPrepaidCount(right, prepaidMonths);
    } else if (sortedMonth) {
      const leftStatus = monthSortValue(left, sortedMonth, comparisonMonth);
      const rightStatus = monthSortValue(right, sortedMonth, comparisonMonth);
      if (leftStatus.group !== rightStatus.group) return leftStatus.group - rightStatus.group;
      // Unknown and inactive groups never reverse ahead of actionable statuses.
      if (leftStatus.group !== 0) return leftStatus.rank - rightStatus.rank || compareNames(left, right);
      comparison = leftStatus.rank - rightStatus.rank;
    } else {
      comparison = nameCollator.compare(text(left.clientName), text(right.clientName));
    }
    return comparison * direction || compareNames(left, right);
  });
}
