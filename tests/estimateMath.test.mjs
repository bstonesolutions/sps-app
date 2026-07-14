import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateLineAmount,
  estimateTotals,
  formatEstimateMoney,
  withEstimateTotals,
} from "../estimateMath.js";

test("taxable estimates calculate and round line amounts, tax, and total to cents", () => {
  const totals = estimateTotals({
    taxEnabled: true,
    taxRate: "6",
    items: [
      { qty: "2.5", price: "10.019" },
      { qty: 1, price: 1.005 },
    ],
  });

  // Each line is rounded to cents before the estimate subtotal is calculated.
  assert.deepEqual(totals, {
    subtotal: 26.06,
    taxRate: 6,
    taxEnabled: true,
    tax: 1.56,
    total: 27.62,
  });
  assert.equal(formatEstimateMoney(totals.total), "$27.62");
});

test("legacy estimates without taxEnabled remain tax-free", () => {
  const totals = estimateTotals({
    taxRate: "6",
    items: [{ qty: 2, price: 50 }],
  }, 8);

  assert.equal(totals.taxEnabled, false);
  assert.equal(totals.taxRate, 6);
  assert.equal(totals.subtotal, 100);
  assert.equal(totals.tax, 0);
  assert.equal(totals.total, 100);
});

test("turning tax off keeps the saved rate but removes tax from the total", () => {
  const normalized = withEstimateTotals({
    id: "est_1",
    taxEnabled: false,
    taxRate: "6",
    items: [{ qty: 3, unitPrice: "12.50" }],
  }, 8);

  assert.equal(normalized.id, "est_1");
  assert.equal(normalized.taxEnabled, false);
  assert.equal(normalized.taxRate, "6");
  assert.equal(normalized.subtotal, 37.5);
  assert.equal(normalized.taxAmount, 0);
  assert.equal(normalized.tax, 0);
  assert.equal(normalized.total, "$37.50");
});

test("an estimate's saved tax-rate snapshot wins over a later fallback rate", () => {
  const savedRate = estimateTotals({
    taxEnabled: true,
    taxRate: "6",
    items: [{ qty: 1, price: 100 }],
  }, 8);
  const fallbackRate = estimateTotals({
    taxEnabled: true,
    items: [{ qty: 1, price: 100 }],
  }, 8);

  assert.equal(savedRate.taxRate, 6);
  assert.equal(savedRate.tax, 6);
  assert.equal(savedRate.total, 106);
  assert.equal(fallbackRate.taxRate, 8);
  assert.equal(fallbackRate.tax, 8);
  assert.equal(fallbackRate.total, 108);
});

test("line quantities accept decimals and numeric strings, with an omitted quantity defaulting to one", () => {
  assert.equal(estimateLineAmount({ qty: "1.5", price: "$20.00" }), 30);
  assert.equal(estimateLineAmount({ qty: 2, unitPrice: "7.255" }), 14.51);
  assert.equal(estimateLineAmount({ price: "4.25" }), 4.25);
});

test("legacy line totals remain readable when only an amount was stored", () => {
  assert.equal(estimateLineAmount({ desc: "Legacy scope", amount: "$42.75" }), 42.75);
  assert.equal(estimateTotals({ items: [{ amount: "42.75" }], taxEnabled: false }).total, 42.75);
});
