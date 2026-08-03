import assert from "node:assert/strict";
import test from "node:test";

import {
  ESTIMATE_CHARGE_TYPES,
  estimateChargeBreakdown,
  estimateLineChargeLabel,
  estimateLineChargeType,
} from "../estimateBreakdown.js";
import { estimateTotals } from "../estimateMath.js";

test("charge types expose stable customer labels and derive safe defaults from catalog kind", () => {
  assert.deepEqual(
    ESTIMATE_CHARGE_TYPES.map(({ id, label }) => [id, label]),
    [
      ["labor", "Labor & services"],
      ["parts", "Parts"],
      ["materials", "Materials"],
      ["equipment", "Equipment"],
      ["other", "Other"],
      ["custom", "Custom"],
    ],
  );
  assert.equal(estimateLineChargeType({ kind: "service" }), "labor");
  assert.equal(estimateLineChargeType({ kind: "part" }), "parts");
  assert.equal(estimateLineChargeType({ kind: "bundle" }), "parts");
  assert.equal(estimateLineChargeType({ kind: "product" }), "materials");
  assert.equal(estimateLineChargeType({ kind: "treatment" }), "materials");
  assert.equal(estimateLineChargeType({ kind: "custom" }), "custom");
  assert.equal(estimateLineChargeType({ kind: "unknown" }), "custom");
});

test("an explicit charge type changes the presentation tag without changing operational kind or tax", () => {
  const line = { id: "pump", kind: "product", taxable: true, chargeType: "equipment", qty: "1", price: "400" };
  const before = structuredClone(line);

  assert.equal(estimateLineChargeType(line), "equipment");
  assert.equal(estimateLineChargeLabel(line), "Equipment");
  assert.deepEqual(line, before);
  assert.equal(line.kind, "product");
  assert.equal(line.taxable, true);
});

test("custom labels are plain, compact display text with a safe fallback", () => {
  assert.equal(
    estimateLineChargeLabel({ chargeType: "custom", chargeLabel: "  Specialty\n   subcontractor\twork  " }),
    "Specialty subcontractor work",
  );
  assert.equal(estimateLineChargeLabel({ chargeType: "custom", chargeLabel: "   " }), "Custom");
  assert.equal(estimateLineChargeLabel({ chargeType: "not-a-real-type", chargeLabel: "Travel" }), "Travel");
  assert.equal(
    [...estimateLineChargeLabel({ chargeType: "custom", chargeLabel: "1234567890123456789012345678901234567890extra" })].length,
    40,
  );
});

test("breakdown uses canonical order, preserves line order, and merges custom labels case-insensitively", () => {
  const travelOne = { id: "travel-1", kind: "custom", chargeType: "custom", chargeLabel: " Travel ", qty: "1", price: "10" };
  const part = { id: "part", kind: "part", qty: "2", price: "15" };
  const labor = { id: "labor", kind: "service", qty: "1.5", price: "100" };
  const travelTwo = { id: "travel-2", kind: "custom", chargeType: "custom", chargeLabel: "travel", qty: "1", price: "5" };
  const mobilization = { id: "mobilization", kind: "custom", chargeType: "custom", chargeLabel: "Mobilization", qty: "1", price: "20" };

  const breakdown = estimateChargeBreakdown({ items: [travelOne, part, labor, travelTwo, mobilization] });

  assert.deepEqual(breakdown.map(({ type, label, subtotal, lineCount }) => ({ type, label, subtotal, lineCount })), [
    { type: "labor", label: "Labor & services", subtotal: 150, lineCount: 1 },
    { type: "parts", label: "Parts", subtotal: 30, lineCount: 1 },
    { type: "custom", label: "Travel", subtotal: 15, lineCount: 2 },
    { type: "custom", label: "Mobilization", subtotal: 20, lineCount: 1 },
  ]);
  assert.deepEqual(breakdown[2].items.map((item) => item.id), ["travel-1", "travel-2"]);
});

test("group subtotals exactly reconcile to the estimate subtotal without changing tax", () => {
  const estimate = {
    taxEnabled: true,
    taxRate: "6",
    taxModel: "line-item-v1",
    items: [
      { id: "labor", kind: "service", taxable: false, qty: "3", price: "0.10" },
      { id: "part", kind: "part", taxable: true, qty: "1", price: "0.20" },
      { id: "material", kind: "product", taxable: true, qty: "1", price: "12.345" },
      { id: "blank", kind: "custom", qty: "1", price: "" },
    ],
  };
  const before = structuredClone(estimate);
  const totalsBefore = estimateTotals(estimate);
  const breakdown = estimateChargeBreakdown(estimate);
  const groupedSubtotal = Math.round((breakdown.reduce((sum, group) => sum + group.subtotal, 0) + Number.EPSILON) * 100) / 100;

  assert.equal(groupedSubtotal, totalsBefore.subtotal);
  assert.deepEqual(estimateTotals(estimate), totalsBefore);
  assert.deepEqual(estimate, before);
  assert.equal(totalsBefore.taxableSubtotal, 12.55);
  assert.deepEqual(breakdown.flatMap((group) => group.items.map((item) => item.id)), ["labor", "part", "material"]);
  breakdown.forEach((group) => assert.deepEqual(Object.keys(group), ["type", "label", "items", "subtotal", "lineCount"]));
});
