import { estimateLineAmount } from "./estimateMath.js";

export const ESTIMATE_CHARGE_TYPES = Object.freeze([
  Object.freeze({ id: "labor", label: "Labor & services" }),
  Object.freeze({ id: "parts", label: "Parts" }),
  Object.freeze({ id: "materials", label: "Materials" }),
  Object.freeze({ id: "equipment", label: "Equipment" }),
  Object.freeze({ id: "other", label: "Other" }),
  Object.freeze({ id: "custom", label: "Custom" }),
]);

const chargeTypeById = new Map(ESTIMATE_CHARGE_TYPES.map((entry) => [entry.id, entry]));
const canonicalTypeByLabel = new Map(
  ESTIMATE_CHARGE_TYPES
    .filter((entry) => entry.id !== "custom")
    .map((entry) => [entry.label.toLocaleLowerCase(), entry.id]),
);
const canonicalOrder = new Map(ESTIMATE_CHARGE_TYPES.map((entry, index) => [entry.id, index]));

const cleanText = (value) => String(value == null ? "" : value)
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const cleanCustomLabel = (value) => {
  const cleaned = cleanText(value);
  return cleaned ? [...cleaned].slice(0, 40).join("") : "Custom";
};

export function estimateLineChargeType(line) {
  const explicit = cleanText(line?.chargeType).toLocaleLowerCase();
  if (chargeTypeById.has(explicit)) return explicit;
  if (explicit) return "custom";

  const kind = cleanText(line?.kind).toLocaleLowerCase();
  if (kind === "service") return "labor";
  if (kind === "part" || kind === "bundle") return "parts";
  if (kind === "product" || kind === "treatment") return "materials";
  return "custom";
}

export function estimateLineChargeLabel(line) {
  const type = estimateLineChargeType(line);
  if (type === "custom") return cleanCustomLabel(line?.chargeLabel);
  return chargeTypeById.get(type)?.label || "Custom";
}

const lineHasContent = (line) => {
  if (!line) return false;
  return !!cleanText(line.desc ?? line.description)
    || [line.price, line.unitPrice, line.amount]
      .some((value) => value != null && String(value).trim() !== "")
    || (line.refId != null && String(line.refId).trim() !== "");
};

const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function estimateChargeBreakdown(estimate) {
  const groups = new Map();
  const items = Array.isArray(estimate?.items) ? estimate.items : [];

  items.filter(lineHasContent).forEach((item, itemIndex) => {
    const resolvedType = estimateLineChargeType(item);
    const label = estimateLineChargeLabel(item);
    const key = label.toLocaleLowerCase();
    const canonicalType = canonicalTypeByLabel.get(key);
    const groupType = canonicalType || resolvedType;
    const existing = groups.get(key);

    if (existing) {
      existing.items.push(item);
      existing.subtotal = roundMoney(existing.subtotal + estimateLineAmount(item));
      existing.lineCount += 1;
      if (canonicalType) existing.type = canonicalType;
      return;
    }

    groups.set(key, {
      type: groupType,
      label,
      items: [item],
      subtotal: estimateLineAmount(item),
      lineCount: 1,
      _firstIndex: itemIndex,
    });
  });

  return [...groups.values()]
    .sort((left, right) => {
      const leftRank = left.type === "custom"
        ? ESTIMATE_CHARGE_TYPES.length
        : (canonicalOrder.get(left.type) ?? ESTIMATE_CHARGE_TYPES.length - 1);
      const rightRank = right.type === "custom"
        ? ESTIMATE_CHARGE_TYPES.length
        : (canonicalOrder.get(right.type) ?? ESTIMATE_CHARGE_TYPES.length - 1);
      return leftRank - rightRank || left._firstIndex - right._firstIndex;
    })
    .map(({ _firstIndex, ...group }) => group);
}
