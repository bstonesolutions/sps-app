import test from "node:test";
import assert from "node:assert/strict";

import {
  inventoryAdjustmentDelta,
  inventoryAdjustmentMagnitude,
  inventoryStockAfterAdjustment,
  sanitizeInventoryAdjustmentInput,
} from "../inventoryAdjustment.js";

test("inventory adjustment input accepts an iOS decimal keypad value without requiring a minus key", () => {
  assert.equal(sanitizeInventoryAdjustmentInput("16"), "16");
  assert.equal(sanitizeInventoryAdjustmentInput("1,5"), "1.5");
  assert.equal(sanitizeInventoryAdjustmentInput("-1.2.5 oz"), "1.25");
  assert.equal(inventoryAdjustmentMagnitude("-16"), 16);
});

test("explicit add and remove choices produce the signed delta expected by the existing stock model", () => {
  assert.equal(inventoryAdjustmentDelta({ amount: "16", mode: "adjust", direction: "remove" }), -16);
  assert.equal(inventoryAdjustmentDelta({ amount: "16", mode: "adjust", direction: "add" }), 16);
  assert.equal(inventoryAdjustmentDelta({ amount: "16", mode: "restock", direction: "remove" }), 16);
  assert.equal(inventoryAdjustmentDelta({ amount: "0", mode: "adjust", direction: "remove" }), 0);
  assert.equal(inventoryAdjustmentDelta({ amount: "not a number", mode: "adjust", direction: "add" }), 0);
});

test("removing stock never makes a location negative", () => {
  assert.equal(inventoryStockAfterAdjustment(40, -16), 24);
  assert.equal(inventoryStockAfterAdjustment(10, -16), 0);
  assert.equal(inventoryStockAfterAdjustment(10, 2.5), 12.5);
});
