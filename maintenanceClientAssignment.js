const text = (value) => String(value == null ? "" : value).trim();
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const keyOf = (value) => text(value).toLowerCase().replace(/[^a-z]/g, "");
const OFF_VALUES = new Set(["none", "no plan", "off", "inactive", "disabled", "cancelled", "canceled", "false"]);
const TYPE_ORDER = ["pool", "pond", "leaf"];

function assignedPlan(rawPlan) {
  if (isRecord(rawPlan)) {
    if (rawPlan.active === false || rawPlan.enabled === false || OFF_VALUES.has(text(rawPlan.status).toLowerCase())) return "";
    return assignedPlan(rawPlan.tier ?? rawPlan.plan ?? rawPlan.name);
  }
  if (typeof rawPlan !== "string") return "";
  const plan = text(rawPlan);
  return plan && !OFF_VALUES.has(plan.toLowerCase()) ? plan : "";
}

function maintenanceType(division, client) {
  const key = keyOf(division);
  if (key === "pool" || key === "pond") return key;
  if (["leaf", "leaves", "leafremoval"].includes(key)) return "leaf";
  if (key === "seasonal" && /\b(?:leaf|leaves)\b/i.test(text(client?.seasonalType))) return "leaf";
  return "";
}

/**
 * Current calendar enrollment comes from Services & Plans, never from money or
 * visit history. An explicit per-division None overrides the legacy flat plan.
 * The primary division is always enabled in the client editor; its false service
 * flag is a normal BLANK_CLIENT default. Extra divisions must be toggled on as
 * well as carrying a plan; old plan data can remain after a service is disabled.
 */
export function maintenanceClientAssignments(client) {
  if (!isRecord(client) || client.active === false || OFF_VALUES.has(text(client.status).toLowerCase()) || text(client.status).toLowerCase() === "archived") return [];
  const primary = text(client.division) || "Pond";
  const plans = isRecord(client.plans) ? client.plans : {};
  const divisions = [...new Set([primary, ...Object.keys(plans)])];
  const result = [];
  for (const division of divisions) {
    const type = maintenanceType(division, client);
    if (!type) continue;
    const primaryDivision = keyOf(division) === keyOf(primary);
    if (!primaryDivision && !client[`service${division}`]) continue;
    const planKey = Object.keys(plans).find((key) => keyOf(key) === keyOf(division));
    const plan = assignedPlan(planKey !== undefined ? plans[planKey] : (primaryDivision ? client.plan : ""));
    if (!plan) continue;
    result.push({ type, division, plan });
  }
  const seen = new Set();
  return result.filter((assignment) => {
    const key = keyOf(assignment.division);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => TYPE_ORDER.indexOf(left.type) - TYPE_ORDER.indexOf(right.type));
}

export function maintenanceClientTypes(client) {
  return [...new Set(maintenanceClientAssignments(client).map((assignment) => assignment.type))];
}

export function maintenanceAssignedPriceCents(client, assignments = maintenanceClientAssignments(client)) {
  if (!assignments.length) return null;
  const rates = isRecord(client?.planRates) ? client.planRates : {};
  const cents = (value) => {
    if (value == null || text(value) === "") return null;
    const amount = Number(text(value).replace(/[$,\s]/g, ""));
    return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
  };
  // The invoice flow and Service Tiers bulk editor use monthlyRate as the saved
  // billing price. Bulk price changes do not rewrite older planRates entries.
  const monthlyRate = cents(client?.monthlyRate);
  if (monthlyRate !== null) return monthlyRate;
  const assignedRates = assignments.map(({ division }) => {
    const rateKey = Object.keys(rates).find((key) => keyOf(key) === keyOf(division));
    return rateKey === undefined ? null : cents(rates[rateKey]);
  });
  if (assignedRates.every((rate) => rate !== null)) return assignedRates.reduce((sum, rate) => sum + rate, 0);
  // Old single-rate profiles may use these aliases. Disabled or unrelated
  // division rates never participate in the per-service fallback above.
  return cents(client?.maintenanceRate) ?? cents(client?.price);
}
