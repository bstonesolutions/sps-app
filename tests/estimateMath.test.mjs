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
  estimatePipelineStatus,
  estimatePipelineSummary,
  estimateProfitTotals,
  estimateTotals,
  formatEstimateMoney,
  withEstimateRevision,
  withEstimateTotals,
} from "../estimateMath.js";

test("estimate pipeline summary reports counts and tax-aware dollars for active, approved, and all estimates", () => {
  const estimates = [
    { id: "missing-status", items: [{ price: "10" }] },
    { id: "draft", status: " DRAFT ", items: [{ price: "15" }] },
    { id: "sent", status: "sent", taxEnabled: true, taxRate: "6", items: [{ price: "100" }] },
    { id: "approved", status: "approved", items: [{ price: "50" }] },
    { id: "legacy-approved", status: "accepted", taxEnabled: true, items: [{ price: "100" }] },
    { id: "declined", status: "declined", items: [{ price: "25" }] },
    { id: "complete", status: "complete", items: [{ price: "40" }] },
    { id: "future-status", status: "archived", items: [{ price: "7" }] },
    null,
    "not-an-estimate",
  ];

  const summary = estimatePipelineSummary(estimates, 8);

  assert.deepEqual(summary.active, { count: 3, amount: 131 });
  assert.deepEqual(summary.approved, { count: 2, amount: 158 });
  assert.deepEqual(summary.total, { count: 8, amount: 361 });
  assert.deepEqual(summary.byStatus, {
    draft: { count: 2, amount: 25 },
    sent: { count: 1, amount: 106 },
    approved: { count: 2, amount: 158 },
    declined: { count: 1, amount: 25 },
    complete: { count: 1, amount: 40 },
    other: { count: 1, amount: 7 },
  });
});

test("estimate pipeline summary uses canonical line rounding instead of stale saved totals", () => {
  const summary = estimatePipelineSummary([
    { status: "draft", total: "$999.00", items: [{ qty: "1", price: "0.105" }] },
    { status: "sent", total: "$999.00", items: [{ qty: "1", price: "0.105" }] },
  ]);

  assert.deepEqual(summary.active, { count: 2, amount: 0.22 });
  assert.deepEqual(summary.total, { count: 2, amount: 0.22 });
});

test("estimate status normalization keeps legacy accepted records visibly approved", () => {
  assert.equal(estimatePipelineStatus({ status: " accepted " }), "approved");
  assert.equal(estimatePipelineStatus({ status: "SENT" }), "sent");
  assert.equal(estimatePipelineStatus({ status: "archived" }), "other");
  assert.equal(estimatePipelineStatus({}), "draft");
});

test("estimate pipeline summary handles empty input without mutating estimate records", () => {
  assert.deepEqual(estimatePipelineSummary(), {
    active: { count: 0, amount: 0 },
    approved: { count: 0, amount: 0 },
    total: { count: 0, amount: 0 },
    byStatus: {
      draft: { count: 0, amount: 0 },
      sent: { count: 0, amount: 0 },
      approved: { count: 0, amount: 0 },
      declined: { count: 0, amount: 0 },
      complete: { count: 0, amount: 0 },
      other: { count: 0, amount: 0 },
    },
  });

  const estimates = [{ id: "immutable", status: "approved", taxEnabled: true, items: [{ price: "12.34" }] }];
  const before = structuredClone(estimates);
  estimatePipelineSummary(estimates, 6);
  assert.deepEqual(estimates, before);
});

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
    taxableSubtotal: 26.06,
    taxRate: 6,
    taxEnabled: true,
    tax: 1.56,
    total: 27.62,
  });
  assert.equal(formatEstimateMoney(totals.total), "$27.62");
});

test("estimate money uses professional grouped currency without duplicate dollar signs", () => {
  assert.equal(formatEstimateMoney(0), "$0.00");
  assert.equal(formatEstimateMoney(1234.5), "$1,234.50");
  assert.equal(formatEstimateMoney("$1,234.50"), "$1,234.50");
  assert.equal(formatEstimateMoney(-12.34), "-$12.34");
  assert.equal(formatEstimateMoney(-0), "$0.00");
  assert.equal(formatEstimateMoney(0.105), "$0.11");
  assert.equal(formatEstimateMoney(null), "$0.00");
  assert.equal(formatEstimateMoney(Number.NaN), "$0.00");
});

test("line-item tax excludes services while taxing products and supports explicit overrides", () => {
  const totals = estimateTotals({
    taxEnabled: true,
    taxRate: "6",
    taxModel: "line-item-v1",
    items: [
      { kind: "service", qty: "1", price: "200" },
      { kind: "product", qty: "2", price: "25" },
      { kind: "product", taxable: false, qty: "1", price: "10" },
      { kind: "service", taxable: true, qty: "1", price: "5" },
    ],
  });

  assert.equal(totals.subtotal, 265);
  assert.equal(totals.taxableSubtotal, 55);
  assert.equal(totals.tax, 3.3);
  assert.equal(totals.total, 268.3);
});

test("legacy tax-enabled estimates remain quote-wide until deliberately revised", () => {
  const totals = estimateTotals({
    taxEnabled: true,
    taxRate: "6",
    items: [{ kind: "service", qty: "1", price: "200" }],
  });

  assert.equal(totals.taxableSubtotal, 200);
  assert.equal(totals.tax, 12);
  assert.equal(totals.total, 212);
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
  assert.equal(formatEstimateMoney(estimateLineUnitPrice({ unitPrice: "1,200.00" })), "$1,200.00");
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

test("customer-visible edits reopen complete estimates without discarding their invoice link", () => {
  const completed = withEstimateTotals({
    id: "est-complete",
    status: "complete",
    completedAt: "2026-07-28T16:00:00.000Z",
    linkedInvoiceId: "invoice-1",
    linkedInvoiceNumber: "INV-101",
    items: [{ id: "line-1", desc: "Service", qty: "1", price: "100" }],
  });

  const revised = withEstimateRevision(completed, { title: "Revised service" });

  assert.equal(revised.status, "draft");
  assert.equal(revised.completedAt, undefined);
  assert.equal(revised.linkedInvoiceId, "invoice-1");
  assert.equal(revised.linkedInvoiceNumber, "INV-101");
});

test("internal edits preserve a complete estimate and its completion metadata", () => {
  const completedAt = "2026-07-28T16:00:00.000Z";
  const completed = withEstimateTotals({
    id: "est-complete",
    status: "complete",
    completedAt,
    linkedInvoiceId: "invoice-1",
    items: [{ id: "line-1", desc: "Service", qty: "1", price: "100" }],
  });

  const corrected = withEstimateRevision(completed, {
    items: [{ ...completed.items[0], unitCost: "40", costKnown: true }],
  }, 0, { customerVisible: false });

  assert.equal(corrected.status, "complete");
  assert.equal(corrected.completedAt, completedAt);
  assert.equal(corrected.linkedInvoiceId, "invoice-1");
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
