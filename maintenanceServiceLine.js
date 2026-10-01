const text = (value) => String(value == null ? "" : value).trim();

export function isMaintenanceServiceExtra(service) {
  if (!service || service.bill === false) return false;
  if (service.billSeparately === true || service.includedInMaintenance === false
    || ["one-off", "oneoff", "single"].includes(text(service.billingMode).toLowerCase())) return true;
  const description = typeof service === "string" ? service : service.desc || service.description || service.name || service.type;
  return /\b(?:repair|repairs|project|install|installation|startup|start-up|cleanout|clean-out|inspection|consultation|emergency|renovation|construction|replacement|replace)\b|service\s*call/i.test(text(description));
}

export function isMaintenanceServiceLine(invoice, line) {
  if (!line || typeof line !== "object") return false;
  if (["part", "product", "treatment", "bundle", "latefee", "late-fee"].includes(text(line.kind).toLowerCase()) || line.isLateFee) return false;
  if (isMaintenanceServiceExtra(line)) return false;
  const description = text(line.desc || line.description || line.name);
  if (/\b(?:opening|closing|winterizing|winterization|late\s+fee)\b/i.test(description)) return false;
  return /\bmaintenance\b|\b(?:weekly|bi[\s-]?weekly|monthly|recurring)\s+(?:(?:pool|pond|leaf)\s+)?service\b/i.test(description)
    || line.maintenanceService === true
    || text(invoice?.source) === "monthly-maintenance";
}

/** Classify the performed source type, never a client's plan or a date alone. */
export function isMaintenanceServiceFromSource(source, line) {
  return isMaintenanceServiceLine({}, { desc: text(source?.type || source?.serviceType), kind: "service" })
    && isMaintenanceServiceLine({ source: "monthly-maintenance" }, line);
}
