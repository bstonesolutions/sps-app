export function sanitizeInventoryAdjustmentInput(value) {
  const normalized = String(value ?? "").replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const [whole = "", ...decimalParts] = normalized.split(".");
  return decimalParts.length > 0 ? `${whole}.${decimalParts.join("")}` : whole;
}

export function inventoryAdjustmentMagnitude(value) {
  const amount = Number.parseFloat(sanitizeInventoryAdjustmentInput(value));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function inventoryAdjustmentValue(value) {
  const normalized = sanitizeInventoryAdjustmentInput(value);
  if (!normalized || normalized === ".") return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function inventoryAdjustmentOperation(value) {
  return ["add", "remove", "set"].includes(value) ? value : "remove";
}

function finiteInventoryQuantity(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  if (!Number.isFinite(rounded)) return null;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function inventoryQuantity(value) {
  return finiteInventoryQuantity(value) ?? 0;
}

export function inventoryAdjustmentInputIsValid(value, { allowZero = false } = {}) {
  const parsed = inventoryAdjustmentValue(value);
  return parsed != null && (allowZero ? parsed >= 0 : parsed > 0);
}

export function inventoryAdjustmentIsValid({ amount, operation = "remove" } = {}) {
  return inventoryAdjustmentInputIsValid(amount, {
    allowZero: inventoryAdjustmentOperation(operation) === "set",
  });
}

// Returns the complete operation outcome so the UI can preview a capped removal, distinguish the
// requested amount from the amount actually applied, and accept zero when setting a physical count.
export function inventoryAdjustmentResult({ current, amount, operation = "remove" } = {}) {
  const normalizedOperation = inventoryAdjustmentOperation(operation);
  const parsedCurrent = Number.parseFloat(current);
  const safeCurrent = inventoryQuantity(Number.isFinite(parsedCurrent) ? Math.max(0, parsedCurrent) : 0);
  const requestedAmount = inventoryAdjustmentValue(amount);
  const valid = inventoryAdjustmentIsValid({ amount, operation: normalizedOperation });

  if (!valid) {
    return {
      valid: false,
      operation: normalizedOperation,
      current: safeCurrent,
      requestedAmount,
      appliedAmount: 0,
      delta: 0,
      next: safeCurrent,
      overdraw: false,
    };
  }

  if (normalizedOperation === "set") {
    const appliedAmount = finiteInventoryQuantity(Math.abs(requestedAmount - safeCurrent));
    const delta = finiteInventoryQuantity(requestedAmount - safeCurrent);
    const next = finiteInventoryQuantity(requestedAmount);
    if (appliedAmount == null || delta == null || next == null) {
      return {
        valid: false,
        operation: normalizedOperation,
        current: safeCurrent,
        requestedAmount,
        appliedAmount: 0,
        delta: 0,
        next: safeCurrent,
        overdraw: false,
      };
    }
    return {
      valid: true,
      operation: normalizedOperation,
      current: safeCurrent,
      requestedAmount,
      appliedAmount,
      delta,
      next,
      overdraw: false,
    };
  }

  const overdraw = normalizedOperation === "remove" && requestedAmount > safeCurrent;
  const appliedAmount = normalizedOperation === "remove"
    ? Math.min(requestedAmount, safeCurrent)
    : requestedAmount;
  const delta = finiteInventoryQuantity(normalizedOperation === "remove" ? -appliedAmount : appliedAmount);
  const next = delta == null ? null : finiteInventoryQuantity(safeCurrent + delta);

  if (delta == null || next == null) {
    return {
      valid: false,
      operation: normalizedOperation,
      current: safeCurrent,
      requestedAmount,
      appliedAmount: 0,
      delta: 0,
      next: safeCurrent,
      overdraw: false,
    };
  }

  return {
    valid: true,
    operation: normalizedOperation,
    current: safeCurrent,
    requestedAmount,
    appliedAmount,
    delta,
    next,
    overdraw,
  };
}

export function inventoryStockAfterOperation(options) {
  return inventoryAdjustmentResult(options).next;
}

// A transfer is deliberately all-or-nothing. Moving more than the source location owns must never
// manufacture the difference at the destination or silently turn the request into a partial move.
export function inventoryTransferResult({ available, destination = 0, amount } = {}) {
  const parsedAvailable = Number.parseFloat(available);
  const parsedDestination = Number.parseFloat(destination);
  const safeAvailable = inventoryQuantity(Number.isFinite(parsedAvailable) ? Math.max(0, parsedAvailable) : 0);
  const safeDestination = inventoryQuantity(Number.isFinite(parsedDestination) ? Math.max(0, parsedDestination) : 0);
  const requestedAmount = inventoryAdjustmentValue(amount);
  const inputValid = requestedAmount != null && requestedAmount > 0;
  const overdraw = inputValid && requestedAmount > safeAvailable;
  const sourceNext = inputValid && !overdraw
    ? finiteInventoryQuantity(safeAvailable - requestedAmount)
    : null;
  const destinationNext = inputValid && !overdraw
    ? finiteInventoryQuantity(safeDestination + requestedAmount)
    : null;
  const valid = inputValid && !overdraw && sourceNext != null && destinationNext != null;

  return {
    valid,
    available: safeAvailable,
    destination: safeDestination,
    requestedAmount,
    movedAmount: valid ? requestedAmount : 0,
    sourceNext: valid ? sourceNext : safeAvailable,
    destinationNext: valid ? destinationNext : safeDestination,
    overdraw,
  };
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
  const next = safeCurrent + safeChange;
  return Number.isFinite(next) ? Math.max(0, next) : Math.max(0, safeCurrent);
}
