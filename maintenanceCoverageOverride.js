// The owner's explicit decision to bill an invoice even though SPS could not match it to
// maintenance coverage (no linked visit, unverified payment history, or an already-covered
// month). It is a decision on the saved record, never a request flag: servers honor it only
// from the record they read themselves (the saved invoice or the saved billing review).
const text = value => String(value == null ? "" : value).trim();

export function maintenanceCoverageOverride(record) {
  const override = record?.maintenanceCoverageOverride;
  if (!override || typeof override !== "object" || Array.isArray(override)) return null;
  return Number(override.version) === 1 && text(override.at) && text(override.by) ? override : null;
}

export function newMaintenanceCoverageOverride(by, now = Date.now()) {
  return { version: 1, at: new Date(now).toISOString(), by: text(by) || "owner" };
}
