export function sanitizeInventoryAdjustmentInput(value) {
  const normalized = String(value ?? "").replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const [whole = "", ...decimalParts] = normalized.split(".");
  return decimalParts.length > 0 ? `${whole}.${decimalParts.join("")}` : whole;
}

export function inventoryAdjustmentMagnitude(value) {
  const amount = Number.parseFloat(sanitizeInventoryAdjustmentInput(value));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function inventoryAdjustmentDelta({ amount, mode = "adjust", direction = "remove" } = {}) {
  const magnitude = inventoryAdjustmentMagnitude(amount);
  if (!magnitude) return 0;
  return mode === "restock" || direction === "add" ? magnitude : -magnitude;
}

export function inventoryStockAfterAdjustment(current, delta) {
  const currentAmount = Number.parseFloat(current);
  const change = Number.parseFloat(delta);
  const safeCurrent = Number.isFinite(currentAmount) ? currentAmount : 0;
  const safeChange = Number.isFinite(change) ? change : 0;
  return Math.max(0, safeCurrent + safeChange);
}
