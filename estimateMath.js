export const parseEstimateNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  const normalized = raw.replace(/^\$\s*/, "");
  // Accept plain decimals and correctly grouped legacy currency values, but never coerce
  // malformed edits such as "." or "1..2" into a different customer-visible amount.
  if (!/^-?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

export const estimateNumberIsValid = (value) => parseEstimateNumber(value) != null;
export const estimateNumberValue = (value) => parseEstimateNumber(value) ?? 0;

export const estimateHasValidTaxRate = (estimate) => {
  if (!estimate || estimate.taxEnabled !== true) return true;
  return estimateNumberIsValid(estimate.taxRate) && estimateNumberValue(estimate.taxRate) >= 0;
};

export const estimateHasValidDays = (estimate) => {
  const value = estimate && estimate.validDays;
  return estimateNumberIsValid(value) && Number.isInteger(estimateNumberValue(value)) && estimateNumberValue(value) > 0;
};

const roundMoney = (value) => Math.round((estimateNumberValue(value) + Number.EPSILON) * 100) / 100;

const hasValue = (value) => value != null && String(value).trim() !== "";

export const estimateLineQuantity = (item) => {
  const raw = item && item.qty;
  // Older estimates sometimes omitted quantity. Keep their historical one-unit behavior,
  // while respecting an explicit zero instead of silently turning it into one.
  return hasValue(raw) ? estimateNumberValue(raw) : 1;
};

export const estimateLineUnitPrice = (item) => estimateNumberValue(item && (item.price ?? item.unitPrice));

export function estimateLineAmount(item) {
  const qty = estimateLineQuantity(item);
  const unitPrice = item && (item.price ?? item.unitPrice);
  if ((unitPrice == null || unitPrice === "") && item && item.amount != null) return roundMoney(item.amount);
  return roundMoney(qty * estimateLineUnitPrice(item));
}

export function estimateLineHasKnownCost(item) {
  if (!item) return false;
  const unitCost = item.unitCost ?? item.cost;
  if (estimateNumberIsValid(unitCost) || estimateNumberIsValid(item.costAmount)) return item.costKnown !== false;
  return false;
}

export function estimateLineCost(item) {
  const unitCost = item && (item.unitCost ?? item.cost);
  if (estimateLineHasKnownCost(item)) {
    if (!hasValue(unitCost) && item && item.costAmount != null) return roundMoney(item.costAmount);
    return roundMoney(estimateLineQuantity(item) * estimateNumberValue(unitCost));
  }
  // A bundle may contain a mix of costed and uncosted parts. Count the known portion so the
  // "known cost so far" figure remains truthful, while costComplete/profit stay unavailable.
  if (estimateNumberIsValid(item && item.knownUnitCost)) return roundMoney(estimateLineQuantity(item) * estimateNumberValue(item.knownUnitCost));
  return 0;
}

const estimateLineHasContent = (item) => {
  if (!item) return false;
  return !!String(item.desc ?? item.description ?? "").trim()
    || hasValue(item.price)
    || hasValue(item.unitPrice)
    || hasValue(item.amount)
    || hasValue(item.refId);
};

export function estimateProfitTotals(estimate) {
  const items = Array.isArray(estimate && estimate.items) ? estimate.items : [];
  const pricedItems = items.filter(estimateLineHasContent);
  const revenue = roundMoney(pricedItems.reduce((sum, item) => sum + estimateLineAmount(item), 0));
  const knownCost = roundMoney(pricedItems.reduce((sum, item) => sum + estimateLineCost(item), 0));
  const missingCostLineIds = pricedItems
    .map((item, index) => estimateLineHasKnownCost(item) ? null : (item.id || `line-${index + 1}`))
    .filter(Boolean);
  const costComplete = pricedItems.length > 0 && missingCostLineIds.length === 0;
  const profit = costComplete ? roundMoney(revenue - knownCost) : null;
  const margin = costComplete && revenue > 0
    ? Math.round(((profit / revenue) * 100 + Number.EPSILON) * 100) / 100
    : null;

  return {
    revenue,
    cost: knownCost,
    costComplete,
    missingCostLines: missingCostLineIds.length,
    missingCostLineIds,
    profit,
    margin,
  };
}

export function estimateTotals(estimate, fallbackRate = 0) {
  const items = Array.isArray(estimate && estimate.items) ? estimate.items : [];
  const subtotal = roundMoney(items.reduce((sum, item) => sum + estimateLineAmount(item), 0));
  const rawRate = estimate && estimate.taxRate != null ? estimate.taxRate : fallbackRate;
  const taxRate = Math.max(0, estimateNumberValue(rawRate));
  // Legacy estimates predate taxEnabled. Treating only an explicit true as taxable prevents
  // historical sent/approved estimates from silently increasing when this feature ships.
  // Estimate tax is quote-wide: the single toggle/rate applies to the entire subtotal. Do not
  // imply a selective per-line rule that the estimate workflow does not offer.
  const taxEnabled = !!(estimate && estimate.taxEnabled === true);
  const tax = taxEnabled ? roundMoney(subtotal * taxRate / 100) : 0;
  return { subtotal, taxRate, taxEnabled, tax, total: roundMoney(subtotal + tax) };
}

export function formatEstimateMoney(value) {
  return `$${roundMoney(value).toFixed(2)}`;
}

export function withEstimateTotals(estimate, fallbackRate = 0) {
  const totals = estimateTotals(estimate, fallbackRate);
  const financials = estimateProfitTotals(estimate);
  return {
    ...estimate,
    taxEnabled: totals.taxEnabled,
    taxRate: String(totals.taxRate),
    subtotal: totals.subtotal,
    taxAmount: totals.tax,
    tax: totals.tax,
    total: formatEstimateMoney(totals.total),
    estimatedCost: financials.cost,
    estimatedProfit: financials.profit,
    estimatedMargin: financials.margin,
    costComplete: financials.costComplete,
    missingCostLines: financials.missingCostLines,
  };
}

export function withEstimateRevision(current, patch, fallbackRate = 0, { customerVisible = true } = {}) {
  const next = { ...current, ...patch };
  if (customerVisible && ["sent", "approved", "declined"].includes(String(current?.status || "").toLowerCase())) {
    next.status = "draft";
    delete next.approvedAt;
    delete next.declinedAt;
    delete next.sentAt;
  }
  const normalized = withEstimateTotals(next, fallbackRate);
  // A controlled decimal field must be allowed to hold an in-progress value such as "6."
  // or ".". Validation rejects malformed values before save/share; normalizing on each
  // keystroke would turn "6." into "6" (so the next 5 becomes 65) or "." into a fake zero.
  return Object.prototype.hasOwnProperty.call(next, "taxRate")
    ? { ...normalized, taxRate: next.taxRate }
    : normalized;
}
