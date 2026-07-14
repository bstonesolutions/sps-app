import { estimateNumberIsValid, estimateNumberValue } from "./estimateMath.js";

const hasValue = (value) => value != null && String(value).trim() !== "";
const roundMoney = (value) => Math.round((estimateNumberValue(value) + Number.EPSILON) * 100) / 100;

export function catalogItemFinancials(kind, item = {}) {
  const normalizedKind = ["service", "product", "treatment", "part"].includes(kind) ? kind : "custom";
  const price = normalizedKind === "treatment"
    ? item.retailPerOz
    : normalizedKind === "part"
      ? item.retailPer
      : item.price;
  const cost = normalizedKind === "treatment"
    ? item.costPerOz
    : normalizedKind === "part"
      ? item.costPer
      : item.cost;
  const unit = item.unit || (
    normalizedKind === "service" ? (item.price_type === "hourly" ? "hr" : "service")
      : normalizedKind === "product" ? "each"
        : normalizedKind === "treatment" ? "oz"
          : normalizedKind === "part" ? "pieces"
            : "each"
  );
  const hasStockMap = !!(item.stockByLoc && typeof item.stockByLoc === "object");
  const stockLocations = hasStockMap
    ? Object.values(item.stockByLoc)
    : [];
  const inventoryTracked = ["product", "treatment", "part"].includes(normalizedKind);
  const priceKnown = estimateNumberIsValid(price) && estimateNumberValue(price) >= 0;
  const costKnown = estimateNumberIsValid(cost) && estimateNumberValue(cost) >= 0;
  const onHand = inventoryTracked
    ? roundMoney(hasStockMap
      ? stockLocations.reduce((sum, value) => sum + estimateNumberValue(value), 0)
      : item.inventoryOz)
    : null;

  return {
    kind: normalizedKind,
    price,
    priceKnown,
    cost,
    costKnown,
    unit,
    inventoryTracked,
    onHand,
  };
}

export function estimateLineFromCatalog(kind, item, id) {
  const financials = catalogItemFinancials(kind, item);
  return {
    id,
    desc: item?.name || "",
    qty: "1",
    price: financials.priceKnown ? String(financials.price) : "",
    unitCost: financials.costKnown ? String(financials.cost) : "",
    costKnown: financials.costKnown,
    kind: financials.kind,
    refId: item?.id ?? null,
    unit: financials.unit,
  };
}

export function estimateLineFromPartsBundle(selected, id) {
  const entries = (Array.isArray(selected) ? selected : []).filter((entry) => entry && entry.part);
  if (entries.some((entry) => hasValue(entry.qty) && (!estimateNumberIsValid(entry.qty) || !(estimateNumberValue(entry.qty) > 0)))) return null;
  const parts = entries
    .map((entry) => {
      const qty = hasValue(entry.qty) ? estimateNumberValue(entry.qty) : 1;
      const financials = catalogItemFinancials("part", entry.part);
      return { entry, qty, financials };
    })
    .filter(({ qty }) => qty > 0);

  if (!parts.length) return null;

  const bundleItems = parts.map(({ entry, qty, financials }) => ({
    kind: "part",
    refId: entry.part.id ?? null,
    name: entry.part.name || "Part",
    qty: String(qty),
    unit: financials.unit,
    unitPrice: financials.priceKnown ? String(financials.price) : "",
    priceKnown: financials.priceKnown,
    unitCost: financials.costKnown ? String(financials.cost) : "",
    costKnown: financials.costKnown,
  }));
  const retailComplete = parts.every(({ financials }) => financials.priceKnown);
  const totalPrice = roundMoney(parts.reduce((sum, { qty, financials }) => sum + qty * estimateNumberValue(financials.price), 0));
  const costKnown = parts.every(({ financials }) => financials.costKnown);
  const knownUnitCost = roundMoney(parts.reduce((sum, { qty, financials }) => (
    sum + (financials.costKnown ? qty * estimateNumberValue(financials.cost) : 0)
  ), 0));
  const totalCost = costKnown ? knownUnitCost : null;
  const bundleNote = parts
    .map(({ entry, qty, financials }) => {
      const unit = String(financials.unit || "").trim();
      const showQuantity = qty !== 1 || (unit && !["piece", "pieces", "each"].includes(unit));
      return `${entry.part.name || "Part"}${showQuantity ? ` ×${qty}${unit ? ` ${unit}` : ""}` : ""}`;
    })
    .join(", ");

  return {
    id,
    desc: `Parts & Materials — ${bundleNote}`,
    qty: "1",
    price: totalPrice.toFixed(2),
    retailComplete,
    unitCost: costKnown ? totalCost.toFixed(2) : "",
    knownUnitCost: knownUnitCost.toFixed(2),
    costKnown,
    kind: "bundle",
    unit: "bundle",
    bundleNote,
    bundleItems,
  };
}
