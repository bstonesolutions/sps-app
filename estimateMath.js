const numberValue = (value) => {
  const parsed = Number.parseFloat(String(value == null ? "" : value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const roundMoney = (value) => Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;

export function estimateLineAmount(item) {
  const qty = numberValue(item && item.qty) || 1;
  const unitPrice = item && (item.price ?? item.unitPrice);
  if ((unitPrice == null || unitPrice === "") && item && item.amount != null) return roundMoney(item.amount);
  return roundMoney(qty * numberValue(unitPrice));
}

export function estimateTotals(estimate, fallbackRate = 0) {
  const items = Array.isArray(estimate && estimate.items) ? estimate.items : [];
  const subtotal = roundMoney(items.reduce((sum, item) => sum + estimateLineAmount(item), 0));
  const rawRate = estimate && estimate.taxRate != null ? estimate.taxRate : fallbackRate;
  const taxRate = Math.max(0, numberValue(rawRate));
  // Legacy estimates predate taxEnabled. Treating only an explicit true as taxable prevents
  // historical sent/approved estimates from silently increasing when this feature ships.
  const taxEnabled = !!(estimate && estimate.taxEnabled === true);
  const tax = taxEnabled ? roundMoney(subtotal * taxRate / 100) : 0;
  return { subtotal, taxRate, taxEnabled, tax, total: roundMoney(subtotal + tax) };
}

export function formatEstimateMoney(value) {
  return `$${roundMoney(value).toFixed(2)}`;
}

export function withEstimateTotals(estimate, fallbackRate = 0) {
  const totals = estimateTotals(estimate, fallbackRate);
  return {
    ...estimate,
    taxEnabled: totals.taxEnabled,
    taxRate: String(totals.taxRate),
    subtotal: totals.subtotal,
    taxAmount: totals.tax,
    tax: totals.tax,
    total: formatEstimateMoney(totals.total),
  };
}
