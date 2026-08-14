import test from "node:test";
import assert from "node:assert/strict";

import { calculateInventoryUnitCost, inventoryPackageCost, MAX_UNIT_COST_DECIMALS } from "../inventoryPricing.js";

test("calculates working-unit cost from the package price and contained quantity", () => {
  assert.deepEqual(calculateInventoryUnitCost("160", "128"), {
    valid: true,
    packagePrice: 160,
    packageQuantity: 128,
    unitCost: "1.25",
  });
  assert.deepEqual(inventoryPackageCost({ packagePrice: "160", packageQuantity: "128" }), {
    valid: true,
    unitCost: 1.25,
    unitCostText: "1.25",
    error: "",
  });
});

test("uses a deterministic canonical string with at most six decimal places", () => {
  assert.equal(MAX_UNIT_COST_DECIMALS, 6);
  assert.equal(calculateInventoryUnitCost("100", "3").unitCost, "33.333333");
  assert.equal(calculateInventoryUnitCost("1", "8").unitCost, "0.125");
  assert.equal(calculateInventoryUnitCost("10.00", "4.0").unitCost, "2.5");
});

test("allows a deliberately free package but requires a positive contained quantity", () => {
  assert.deepEqual(calculateInventoryUnitCost("0", "128"), {
    valid: true,
    packagePrice: 0,
    packageQuantity: 128,
    unitCost: "0",
  });
  assert.equal(calculateInventoryUnitCost("10", "0").valid, false);
  assert.equal(calculateInventoryUnitCost("10", "-2").valid, false);
  assert.deepEqual(inventoryPackageCost({ packagePrice: "10", packageQuantity: "0" }), {
    valid: false,
    unitCost: null,
    unitCostText: "",
    error: "Enter how many working units the package contains.",
  });
});

test("rejects malformed, partial, negative, and non-finite package values", () => {
  for (const [price, quantity] of [
    ["", "4"],
    [".", "4"],
    ["1..2", "4"],
    ["12 dollars", "4"],
    ["-1", "4"],
    ["10", "two"],
    [Infinity, "4"],
  ]) {
    const result = calculateInventoryUnitCost(price, quantity);
    assert.equal(result.valid, false);
    assert.equal(result.unitCost, "");
  }
});

test("rejects a package calculation when the computed unit cost overflows", () => {
  const result = calculateInventoryUnitCost("9".repeat(308), "0.000001");
  assert.equal(result.valid, false);
  assert.equal(result.unitCost, "");
  assert.deepEqual(inventoryPackageCost({
    packagePrice: "9".repeat(308),
    packageQuantity: "0.000001",
  }), {
    valid: false,
    unitCost: null,
    unitCostText: "",
    error: "The package cost could not be calculated.",
  });
});
