import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateHasValidDays,
  estimateHasValidTaxRate,
  estimateLineAmount,
  estimateLineCost,
  estimateLineHasKnownCost,
  estimateLineQuantity,
  estimateLineUnitPrice,
  estimateNumberIsValid,
  estimateNumberValue,
  estimateProfitTotals,
  estimateTotals,
  formatEstimateMoney,
  withEstimateRevision,
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
  assert.equal(estimateLineQuantity({ qty: "" }), 1);
  assert.equal(estimateLineQuantity({ qty: "0" }), 0);
  assert.equal(estimateLineAmount({ qty: "1.5", price: "$20.00" }), 30);
  assert.equal(estimateLineAmount({ qty: 2, unitPrice: "7.255" }), 14.51);
  assert.equal(estimateLineAmount({ price: "4.25" }), 4.25);
  assert.equal(estimateLineAmount({ qty: "0", price: "99" }), 0);
});

test("formatted legacy unit prices render from the same normalized value used by totals", () => {
  assert.equal(estimateLineUnitPrice({ price: "$20.00" }), 20);
  assert.equal(estimateLineUnitPrice({ unitPrice: "1,200.00" }), 1200);
  assert.equal(formatEstimateMoney(estimateLineUnitPrice({ unitPrice: "1,200.00" })), "$1200.00");
  assert.equal(estimateLineAmount({ qty: "2", unitPrice: "1,200.00" }), 2400);
});

test("malformed decimal edits never become known money values", () => {
  assert.equal(estimateNumberIsValid("."), false);
  assert.equal(estimateNumberIsValid("1..2"), false);
  assert.equal(estimateNumberIsValid("1,20.00"), false);
  assert.equal(estimateNumberIsValid("$1,200.00"), true);
  assert.equal(estimateNumberIsValid("0"), true);
  assert.equal(estimateNumberValue("1..2"), 0);
  assert.equal(estimateLineHasKnownCost({ unitCost: ".", costKnown: true }), false);
});

test("enabled tax requires a valid nonnegative rate before an estimate can be shared", () => {
  assert.equal(estimateHasValidTaxRate({ taxEnabled: true, taxRate: "6" }), true);
  assert.equal(estimateHasValidTaxRate({ taxEnabled: true, taxRate: "6..5" }), false);
  assert.equal(estimateHasValidTaxRate({ taxEnabled: true, taxRate: "" }), false);
  assert.equal(estimateHasValidTaxRate({ taxEnabled: true, taxRate: "-1" }), false);
  assert.equal(estimateHasValidTaxRate({ taxEnabled: false, taxRate: "6..5" }), true);
});

test("tax-rate edits preserve in-progress decimal input until validated persistence", () => {
  const base = { status: "draft", taxEnabled: true, taxRate: "6", items: [] };
  const trailingDecimal = withEstimateRevision(base, { taxRate: "6." });
  const malformed = withEstimateRevision(base, { taxRate: "." });
  const malformedAfterTitleEdit = withEstimateRevision(malformed, { title: "Repair" });

  assert.equal(trailingDecimal.taxRate, "6.");
  assert.equal(estimateHasValidTaxRate(trailingDecimal), true);
  assert.equal(malformed.taxRate, ".");
  assert.equal(estimateHasValidTaxRate(malformed), false);
  assert.equal(malformedAfterTitleEdit.taxRate, ".");
  assert.equal(estimateHasValidTaxRate(malformedAfterTitleEdit), false);
});

test("estimate validity is one consistent positive whole-day value", () => {
  assert.equal(estimateHasValidDays({ validDays: 30 }), true);
  assert.equal(estimateHasValidDays({ validDays: "1" }), true);
  assert.equal(estimateHasValidDays({ validDays: "" }), false);
  assert.equal(estimateHasValidDays({ validDays: "0" }), false);
  assert.equal(estimateHasValidDays({ validDays: "-2" }), false);
  assert.equal(estimateHasValidDays({ validDays: "2.5" }), false);
  assert.equal(estimateHasValidDays({ validDays: "1..2" }), false);
});

test("legacy line totals remain readable when only an amount was stored", () => {
  assert.equal(estimateLineAmount({ desc: "Legacy scope", amount: "$42.75" }), 42.75);
  assert.equal(estimateTotals({ items: [{ amount: "42.75" }], taxEnabled: false }).total, 42.75);
});

test("estimate costs distinguish an intentional zero from a missing cost", () => {
  assert.equal(estimateLineHasKnownCost({ unitCost: "0", costKnown: true }), true);
  assert.equal(estimateLineCost({ qty: "2.5", unitCost: "4.019", costKnown: true }), 10.05);
  assert.equal(estimateLineHasKnownCost({ unitCost: "", costKnown: false }), false);
  assert.equal(estimateLineCost({ qty: 3, unitCost: "", costKnown: false }), 0);
});

test("profit excludes tax and is reported only when every priced line has a known cost", () => {
  const complete = estimateProfitTotals({
    taxEnabled: true,
    taxRate: "6",
    items: [
      { id: "service", desc: "Service", qty: "2", price: "100", unitCost: "40", costKnown: true },
      { id: "part", desc: "Part", qty: "1", price: "25", unitCost: "10", costKnown: true },
    ],
  });
  assert.deepEqual(complete, {
    revenue: 225,
    cost: 90,
    costComplete: true,
    missingCostLines: 0,
    missingCostLineIds: [],
    profit: 135,
    margin: 60,
  });

  const incomplete = estimateProfitTotals({
    items: [
      { id: "known", desc: "Known", qty: "1", price: "100", unitCost: "25", costKnown: true },
      { id: "missing", desc: "Legacy service", qty: "1", price: "50" },
    ],
  });
  assert.equal(incomplete.revenue, 150);
  assert.equal(incomplete.cost, 25);
  assert.equal(incomplete.costComplete, false);
  assert.deepEqual(incomplete.missingCostLineIds, ["missing"]);
  assert.equal(incomplete.profit, null);
  assert.equal(incomplete.margin, null);
});

test("saved estimates persist internal profitability without changing the customer total", () => {
  const normalized = withEstimateTotals({
    id: "estimate-profit",
    taxEnabled: true,
    taxRate: "6",
    items: [{ id: "line", desc: "Repair", qty: "1", price: "200", unitCost: "75", costKnown: true }],
  });
  assert.equal(normalized.total, "$212.00");
  assert.equal(normalized.estimatedCost, 75);
  assert.equal(normalized.estimatedProfit, 125);
  assert.equal(normalized.estimatedMargin, 62.5);
  assert.equal(normalized.costComplete, true);
});

test("internal cost corrections preserve client approval while visible quote edits return to draft", () => {
  const approved = withEstimateTotals({
    id: "est-approved",
    status: "approved",
    approvedAt: "2026-07-14T12:00:00.000Z",
    sentAt: "2026-07-13T12:00:00.000Z",
    items: [{ id: "line-1", desc: "Service", qty: "1", price: "100", unitCost: "", costKnown: false }],
  });
  const costCorrected = withEstimateRevision(approved, {
    items: [{ ...approved.items[0], unitCost: "40", costKnown: true }],
  }, 0, { customerVisible: false });
  assert.equal(costCorrected.status, "approved");
  assert.equal(costCorrected.approvedAt, approved.approvedAt);
  assert.equal(costCorrected.estimatedProfit, 60);

  const repriced = withEstimateRevision(costCorrected, {
    items: [{ ...costCorrected.items[0], price: "110" }],
  });
  assert.equal(repriced.status, "draft");
  assert.equal(repriced.approvedAt, undefined);
  assert.equal(repriced.sentAt, undefined);
});

test("a zero-revenue estimate keeps margin undefined without inventing a percentage", () => {
  const totals = estimateProfitTotals({
    items: [{ id: "free", desc: "Warranty visit", qty: "1", price: "0", unitCost: "0", costKnown: true }],
  });
  assert.equal(totals.costComplete, true);
  assert.equal(totals.profit, 0);
  assert.equal(totals.margin, null);
});

test("an incomplete bundle still contributes its known child costs", () => {
  const totals = estimateProfitTotals({
    items: [{ id: "bundle", desc: "Parts", qty: "2", price: "50", unitCost: "", knownUnitCost: "8", costKnown: false }],
  });
  assert.equal(totals.cost, 16);
  assert.equal(totals.costComplete, false);
  assert.equal(totals.profit, null);
});
