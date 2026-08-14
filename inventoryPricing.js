const PLAIN_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const MAX_UNIT_COST_DECIMALS = 6;

function inventoryPricingNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? "").trim();
  if (!normalized || !PLAIN_DECIMAL.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalInventoryDecimal(value, maxDecimals = MAX_UNIT_COST_DECIMALS) {
  if (!Number.isFinite(value)) return "";
  const precision = Math.max(0, Math.min(MAX_UNIT_COST_DECIMALS, Math.trunc(maxDecimals)));
  const factor = 10 ** precision;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return rounded
    .toFixed(precision)
    .replace(/(?:\.0+|(?:(\.\d*?[1-9])0+))$/, "$1");
}

// Package quantity is expressed in the item's working unit. For example, a $160 gallon-sized
// container tracked as 128 oz yields a canonical $1.25/oz cost. Keeping the conversion explicit
// avoids guessing whether user-entered "oz" means fluid ounces or weight.
export function calculateInventoryUnitCost(packagePrice, packageQuantity) {
  const price = inventoryPricingNumber(packagePrice);
  const quantity = inventoryPricingNumber(packageQuantity);
  const inputsValid = price != null && price >= 0 && quantity != null && quantity > 0;
  const calculatedUnitCost = inputsValid ? price / quantity : null;
  const unitCost = Number.isFinite(calculatedUnitCost)
    ? canonicalInventoryDecimal(calculatedUnitCost)
    : "";
  const valid = inputsValid && unitCost !== "";

  if (!valid) {
    return {
      valid: false,
      packagePrice: price,
      packageQuantity: quantity,
      unitCost: "",
    };
  }

  return {
    valid: true,
    packagePrice: price,
    packageQuantity: quantity,
    unitCost,
  };
}

export function inventoryPackageCost({ packagePrice, packageQuantity } = {}) {
  const result = calculateInventoryUnitCost(packagePrice, packageQuantity);
  if (result.valid && result.unitCost !== "") {
    return {
      valid: true,
      unitCost: Number(result.unitCost),
      unitCostText: result.unitCost,
      error: "",
    };
  }

  const parsedPrice = inventoryPricingNumber(packagePrice);
  const parsedQuantity = inventoryPricingNumber(packageQuantity);
  const error = parsedPrice == null || parsedPrice < 0
    ? "Enter a valid package price of zero or more."
    : parsedQuantity == null || parsedQuantity <= 0
      ? "Enter how many working units the package contains."
      : "The package cost could not be calculated.";

  return {
    valid: false,
    unitCost: null,
    unitCostText: "",
    error,
  };
}

export { MAX_UNIT_COST_DECIMALS };
