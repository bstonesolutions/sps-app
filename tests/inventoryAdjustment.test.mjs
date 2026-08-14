import test from "node:test";
import assert from "node:assert/strict";

import {
  inventoryAdjustmentDelta,
  inventoryAdjustmentInputIsValid,
  inventoryAdjustmentIsValid,
  inventoryAdjustmentMagnitude,
  inventoryAdjustmentResult,
  inventoryStockAfterAdjustment,
  inventoryStockAfterOperation,
  inventoryTransferResult,
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

test("explicit operations add, remove, and set inventory without signed keyboard input", () => {
  assert.deepEqual(inventoryAdjustmentResult({ current: 10, amount: "2.5", operation: "add" }), {
    valid: true,
    operation: "add",
    current: 10,
    requestedAmount: 2.5,
    appliedAmount: 2.5,
    delta: 2.5,
    next: 12.5,
    overdraw: false,
  });
  assert.equal(inventoryStockAfterOperation({ current: 10, amount: "2.5", operation: "remove" }), 7.5);
  assert.equal(inventoryStockAfterOperation({ current: 10, amount: "4", operation: "set" }), 4);
});

test("setting a physical count to zero is valid while a zero add or removal is not", () => {
  assert.equal(inventoryAdjustmentInputIsValid("0", { allowZero: true }), true);
  assert.equal(inventoryAdjustmentInputIsValid("0"), false);
  assert.equal(inventoryAdjustmentIsValid({ amount: "0", operation: "set" }), true);
  assert.equal(inventoryAdjustmentIsValid({ amount: "0", operation: "add" }), false);
  assert.equal(inventoryAdjustmentIsValid({ amount: "0", operation: "remove" }), false);
  assert.deepEqual(inventoryAdjustmentResult({ current: 10, amount: "0", operation: "set" }), {
    valid: true,
    operation: "set",
    current: 10,
    requestedAmount: 0,
    appliedAmount: 10,
    delta: -10,
    next: 0,
    overdraw: false,
  });
});

test("an overdraw is valid but reports the amount actually removed and caps stock at zero", () => {
  assert.deepEqual(inventoryAdjustmentResult({ current: 10, amount: "16", operation: "remove" }), {
    valid: true,
    operation: "remove",
    current: 10,
    requestedAmount: 16,
    appliedAmount: 10,
    delta: -10,
    next: 0,
    overdraw: true,
  });
});

test("invalid operation input leaves stock unchanged and is never reported as an overdraw", () => {
  assert.deepEqual(inventoryAdjustmentResult({ current: 10, amount: ".", operation: "remove" }), {
    valid: false,
    operation: "remove",
    current: 10,
    requestedAmount: null,
    appliedAmount: 0,
    delta: 0,
    next: 10,
    overdraw: false,
  });
});

test("a transfer is all-or-nothing and can never create stock", () => {
  assert.deepEqual(inventoryTransferResult({ available: 10, destination: 4, amount: "6" }), {
    valid: true,
    available: 10,
    destination: 4,
    requestedAmount: 6,
    movedAmount: 6,
    sourceNext: 4,
    destinationNext: 10,
    overdraw: false,
  });
  assert.deepEqual(inventoryTransferResult({ available: 10, destination: 4, amount: "16" }), {
    valid: false,
    available: 10,
    destination: 4,
    requestedAmount: 16,
    movedAmount: 0,
    sourceNext: 10,
    destinationNext: 4,
    overdraw: true,
  });
});

test("fractional stock math is normalized instead of persisting floating point artifacts", () => {
  assert.equal(inventoryStockAfterOperation({ current: 0.3, amount: "0.1", operation: "remove" }), 0.2);
  assert.equal(inventoryStockAfterOperation({ current: 0.1, amount: "0.2", operation: "add" }), 0.3);
  const moved = inventoryTransferResult({ available: 0.3, destination: 0.1, amount: "0.1" });
  assert.equal(moved.sourceNext, 0.2);
  assert.equal(moved.destinationNext, 0.2);
  assert.equal(moved.sourceNext + moved.destinationNext, 0.4);
});

test("overflowing adjustment math is rejected without changing stock", () => {
  const hugeAmount = "9".repeat(308);
  assert.deepEqual(inventoryAdjustmentResult({ current: 10, amount: hugeAmount, operation: "add" }), {
    valid: false,
    operation: "add",
    current: 10,
    requestedAmount: Number(hugeAmount),
    appliedAmount: 0,
    delta: 0,
    next: 10,
    overdraw: false,
  });
  assert.equal(inventoryStockAfterOperation({ current: 10, amount: hugeAmount, operation: "add" }), 10);
  assert.equal(inventoryAdjustmentResult({ current: 10, amount: hugeAmount, operation: "set" }).valid, false);
  assert.equal(inventoryStockAfterAdjustment(Number(hugeAmount), Number(hugeAmount)), Number(hugeAmount));

  const overflowingTransfer = inventoryTransferResult({
    available: "1".padEnd(303, "0"),
    destination: "1".padEnd(303, "0"),
    amount: "1".padEnd(303, "0"),
  });
  assert.equal(overflowingTransfer.valid, false);
  assert.equal(overflowingTransfer.movedAmount, 0);
  assert.equal(overflowingTransfer.sourceNext, overflowingTransfer.available);
  assert.equal(overflowingTransfer.destinationNext, overflowingTransfer.destination);
});
