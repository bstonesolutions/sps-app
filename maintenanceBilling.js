export const PREPAID_MAINTENANCE_DISPOSITION = "prepaid-maintenance";
export const PREPAID_MAINTENANCE_VERSION = 1;
export const MAINTENANCE_BILLING_STORE_VERSION = 1;

const text = (value) => String(value == null ? "" : value).trim();
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function validDateOrdinal(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return Math.floor(date.getTime() / 86_400_000);
}

function isoDateOrdinal(value) {
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return validDateOrdinal(Number(match[1]), Number(match[2]), Number(match[3]));
}

function scheduledDateOrdinal(value) {
  const raw = text(value);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (iso) return validDateOrdinal(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!mdy) return null;
  return validDateOrdinal(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]));
}

function cadence(value) {
  const normalized = text(value).toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("biweekly") || normalized.includes("everytwoweeks")) return "biweekly";
  if (normalized.includes("weekly")) return "weekly";
  if (normalized.includes("monthly")) return "monthly";
  return normalized;
}

export function recurringMaintenanceCadence(stop, client) {
  return cadence(
    stop?.frequency
    || stop?.routeFreq
    || stop?.cadence
    || stop?.serviceFrequency
    || client?.routeFreq
    || client?.preferredFreq
    || client?.planFreq
    || client?.autoInvoice
    || stop?.type,
  );
}

function isEstimateLinked(stop, entry) {
  return !!(
    text(stop?.source).toLowerCase() === "estimate"
    || text(stop?.sourceEstimateId)
    || text(entry?.sourceEstimateId)
  );
}

export function isRecurringMaintenanceStop(stop, client, entry) {
  if (!isRecord(stop) || stop.cancelled || isEstimateLinked(stop, entry)) return false;
  const billingMode = text(stop.billingMode || stop.billingDisposition).toLowerCase();
  if (["one-off", "oneoff", "single"].includes(billingMode) || stop.recurring === false) return false;

  const type = text(stop.type).toLowerCase();
  if (/repair|project|install|startup|start-up|cleanout|clean-out|inspection|consult|emergency|seasonal|renovation|construction|replacement|service\s*call/.test(type)) {
    return false;
  }

  // A recurrence value describes timing, not the kind of work. Requiring an
  // actual service/maintenance type prevents a weekly repair, diagnostic, or
  // treatment from being silently swallowed by a prepaid maintenance policy.
  // Blank types remain supported for legacy recurring route rows.
  if (type && !/\b(service|maintenance)\b/.test(type)) return false;

  if (["monthly-maintenance", "monthly_maintenance", "recurring-maintenance"].includes(billingMode)) return true;
  const stopCadence = recurringMaintenanceCadence(stop, client);
  if (["weekly", "biweekly", "monthly"].includes(stopCadence)) return true;
  if (stop.recurring === true) return !type || /service|maintenance/.test(type);
  return false;
}

function normalizedPolicy(rawPolicy) {
  if (!isRecord(rawPolicy)) return null;
  if (Number(rawPolicy.version) !== PREPAID_MAINTENANCE_VERSION) return null;
  if (text(rawPolicy.mode).toLowerCase() !== "prepaid") return null;
  const coveredFrom = text(rawPolicy.coveredFrom);
  const coveredThrough = text(rawPolicy.coveredThrough);
  const fromOrdinal = isoDateOrdinal(coveredFrom);
  const throughOrdinal = isoDateOrdinal(coveredThrough);
  if (fromOrdinal == null || throughOrdinal == null || throughOrdinal < fromOrdinal) return null;
  return {
    version: PREPAID_MAINTENANCE_VERSION,
    mode: "prepaid",
    coveredFrom,
    coveredThrough,
    fromOrdinal,
    throughOrdinal,
    ...(text(rawPolicy.sourceInvoiceId) ? { sourceInvoiceId: text(rawPolicy.sourceInvoiceId) } : {}),
    ...(text(rawPolicy.sourceInvoiceNumber) ? { sourceInvoiceNumber: text(rawPolicy.sourceInvoiceNumber) } : {}),
  };
}

function spansWholeCalendarMonths(policy) {
  if (!policy) return false;
  const from = text(policy.coveredFrom).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const through = text(policy.coveredThrough).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!from || !through || Number(from[3]) !== 1) return false;
  const throughYear = Number(through[1]);
  const throughMonth = Number(through[2]);
  const throughDay = Number(through[3]);
  const lastDay = new Date(Date.UTC(throughYear, throughMonth, 0)).getUTCDate();
  return throughDay === lastDay;
}

function normalizedScheduledDate(value) {
  const raw = text(value);
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (match && validDateOrdinal(Number(match[1]), Number(match[2]), Number(match[3])) != null) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match || validDateOrdinal(Number(match[3]), Number(match[1]), Number(match[2])) == null) return "";
  return `${match[3]}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function publicSnapshot(policy) {
  if (!policy) return null;
  const { fromOrdinal, throughOrdinal, ...snapshot } = policy;
  return snapshot;
}

// Shared by the client editor and the completion endpoint so the UI stores the
// exact policy shape the server accepts. Internal date ordinals never enter the
// persisted client record.
export function normalizeMaintenanceBillingPolicy(rawPolicy) {
  const policy = normalizedPolicy(rawPolicy);
  return spansWholeCalendarMonths(policy) ? publicSnapshot(policy) : null;
}

// Prepaid coverage is accounting policy, not ordinary client profile data. The
// server stores the authoritative policy in an owner-protected app_state row;
// the copy on sps_clients is only a UI mirror. Keep the ledger deliberately
// small and strict so a malformed row fails closed instead of silently dropping
// another client's policy during a targeted update.
export function emptyMaintenanceBillingStore() {
  return { version: MAINTENANCE_BILLING_STORE_VERSION, policies: {} };
}

export function normalizeMaintenanceBillingStore(rawStore) {
  if (!isRecord(rawStore)) return null;
  const version = Number(rawStore.version);
  if (![MAINTENANCE_BILLING_STORE_VERSION, 2].includes(version)) return null;
  // Version 2 adds protected month allocations beside the existing policy
  // map. Legacy readers only need the policy projection, but must still fail
  // closed when the v2 envelope is malformed.
  if (version === 2 && !isRecord(rawStore.allocations)) return null;
  if (!isRecord(rawStore.policies)) return null;
  const policies = {};
  for (const [rawClientId, rawPolicy] of Object.entries(rawStore.policies)) {
    const clientId = text(rawClientId);
    const policy = normalizeMaintenanceBillingPolicy(rawPolicy);
    if (!clientId || clientId.length > 220 || clientId !== rawClientId || !policy) return null;
    policies[clientId] = policy;
  }
  return { version: MAINTENANCE_BILLING_STORE_VERSION, policies };
}

export function maintenanceBillingPolicyForClient(rawStore, rawClientId) {
  const store = normalizeMaintenanceBillingStore(rawStore);
  const clientId = text(rawClientId);
  if (!store || !clientId || !hasOwn(store.policies, clientId)) return null;
  return { ...store.policies[clientId] };
}

export function setMaintenanceBillingPolicyInStore(rawStore, rawClientId, rawPolicy) {
  const clientId = text(rawClientId);
  if (!clientId || clientId.length > 220) return null;
  const store = rawStore == null ? emptyMaintenanceBillingStore() : normalizeMaintenanceBillingStore(rawStore);
  if (!store) return null;
  const policies = { ...store.policies };
  if (rawPolicy == null) {
    delete policies[clientId];
  } else {
    const policy = normalizeMaintenanceBillingPolicy(rawPolicy);
    if (!policy) return null;
    policies[clientId] = policy;
  }
  return { version: MAINTENANCE_BILLING_STORE_VERSION, policies };
}

export function prepaidMaintenanceCoverage({
  client,
  stop,
  entry,
  scheduledDate,
  policySource = "client-or-entry",
} = {}) {
  const storedDisposition = text(entry?.billingDisposition).toLowerCase();
  const storedPolicy = storedDisposition === PREPAID_MAINTENANCE_DISPOSITION
    ? normalizedPolicy(entry?.maintenanceBillingSnapshot)
    : null;
  // A completed report's server-written billing disposition is immutable
  // accounting evidence. A retry must not become billable because somebody
  // later renamed or moved the scheduled stop.
  if (storedDisposition === PREPAID_MAINTENANCE_DISPOSITION) {
    if (!storedPolicy) return { covered: false, reason: "stored-policy-invalid" };
    return {
      covered: true,
      reason: "prepaid-maintenance",
      snapshot: publicSnapshot(storedPolicy),
    };
  }

  if (!isRecurringMaintenanceStop(stop, client, entry)) {
    return { covered: false, reason: "not-recurring-maintenance" };
  }
  const policy = policySource === "entry" ? null : normalizedPolicy(client?.maintenanceBilling);
  if (!policy) return { covered: false, reason: "policy-missing-or-invalid" };
  if (!spansWholeCalendarMonths(policy)) {
    return {
      covered: false,
      blocked: true,
      reason: "coverage-must-span-whole-months",
    };
  }

  const stopOrdinal = scheduledDateOrdinal(scheduledDate);
  if (stopOrdinal == null) return { covered: false, reason: "scheduled-date-invalid" };
  if (stopOrdinal < policy.fromOrdinal || stopOrdinal > policy.throughOrdinal) {
    return { covered: false, reason: "outside-coverage" };
  }
  return {
    covered: true,
    reason: "prepaid-maintenance",
    snapshot: publicSnapshot(policy),
  };
}

export function preparePrepaidMaintenanceEntry({ client, stop, entry, scheduledDate } = {}) {
  const decision = prepaidMaintenanceCoverage({ client, stop, entry, scheduledDate, policySource: "client" });
  if (!decision.covered) return { entry, decision };
  const nextEntry = {
    ...(entry || {}),
    invoice: "$0",
    billingDisposition: PREPAID_MAINTENANCE_DISPOSITION,
    maintenanceBillingSnapshot: decision.snapshot,
    ...(normalizedScheduledDate(scheduledDate)
      ? { maintenanceBillingServiceDate: normalizedScheduledDate(scheduledDate) }
      : {}),
  };
  if (!hasOwn(nextEntry, "quoted_price")) {
    const originalAmount = Number.parseFloat(text(entry?.invoice).replace(/[$,]/g, ""));
    if (Number.isFinite(originalAmount) && originalAmount >= 0) nextEntry.quoted_price = originalAmount;
  }
  return { entry: nextEntry, decision };
}
