import test from "node:test";
import assert from "node:assert/strict";

import {
  catalogCategoryGroups,
  catalogItemFinancials,
  estimateLineFromCatalog,
  estimateLineFromPartsBundle,
} from "../estimateCatalog.js";

test("catalog categories retain inventory organization and keep uncategorized items last", () => {
  const pump = { id: "pump", name: "Pump", category: "Pumps" };
  const valve = { id: "valve", name: "Valve", category: "  plumbing  " };
  const union = { id: "union", name: "Union", category: "PLUMBING" };
  const labor = { id: "labor", name: "General labor" };
  const explicit = { id: "misc", name: "Miscellaneous", category: "uncategorized" };

  const groups = catalogCategoryGroups([pump, valve, union, labor, explicit]);

  assert.deepEqual(groups.map((group) => group.category), ["plumbing", "Pumps", "Uncategorized"]);
  assert.deepEqual(groups[0].items, [valve, union], "equivalent category casing and whitespace should merge without reordering its items");
  assert.deepEqual(groups[2].items, [labor, explicit], "blank and explicitly uncategorized items should share the reserved group");
});

test("searching an inventory category returns every item assigned to it", () => {
  const groups = catalogCategoryGroups([
    { id: "a", name: "Beneficial Bacteria", category: "Water Treatments" },
    { id: "b", name: "Clarifier", category: "Water Treatments" },
    { id: "c", name: "Filter Pad", category: "Filtration" },
  ], "water treat");

  assert.equal(groups.length, 1);
  assert.equal(groups[0].category, "Water Treatments");
  assert.deepEqual(groups[0].items.map((item) => item.id), ["a", "b"]);
});

test("searching uncategorized includes blank and explicitly named uncategorized items", () => {
  const groups = catalogCategoryGroups([
    { id: "blank", name: "Loose item", category: "" },
    { id: "named", name: "Miscellaneous", category: "Uncategorized" },
    { id: "other", name: "Pump", category: "Equipment" },
  ], "uncategorized");

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "__uncategorized__");
  assert.deepEqual(groups[0].items.map((item) => item.id), ["blank", "named"]);
});

test("category grouping keeps source order within each category", () => {
  const groups = catalogCategoryGroups([
    { id: "z", name: "Z", category: "Parts" },
    { id: "a", name: "A", category: "Parts" },
    { id: "m", name: "M", category: "Parts" },
  ]);

  assert.deepEqual(groups[0].items.map((item) => item.id), ["z", "a", "m"]);
});

test("every catalog kind snapshots the correct retail, cost, unit, and reference", () => {
  const service = estimateLineFromCatalog("service", { id: "svc", name: "Repair", price: "200", cost: "80", price_type: "flat" }, "line-svc");
  assert.deepEqual(service, {
    id: "line-svc", desc: "Repair", qty: "1", price: "200", unitCost: "80", costKnown: true,
    kind: "service", chargeType: "labor", refId: "svc", unit: "service", taxable: false,
  });

  const treatment = estimateLineFromCatalog("treatment", { id: "tx", name: "Algaecide", retailPerOz: "7.5", costPerOz: "2.25", unit: "oz" }, "line-tx");
  assert.equal(treatment.price, "7.5");
  assert.equal(treatment.unitCost, "2.25");
  assert.equal(treatment.unit, "oz");
  assert.equal(treatment.taxable, true);
  assert.equal(treatment.chargeType, "materials");

  const part = estimateLineFromCatalog("part", { id: "part", name: "Valve", retailPer: "30", costPer: "12", unit: "piece" }, "line-part");
  assert.equal(part.refId, "part");
  assert.equal(part.price, "30");
  assert.equal(part.unitCost, "12");
  assert.equal(part.chargeType, "parts");

  const product = estimateLineFromCatalog("product", { id: "prod", name: "Filter", price: "90", cost: "50" }, "line-prod");
  assert.equal(product.kind, "product");
  assert.equal(product.unit, "each");
  assert.equal(product.taxable, true);
  assert.equal(product.chargeType, "materials");
});

test("an explicit catalog tax override wins over the kind default", () => {
  const taxableService = estimateLineFromCatalog("service", {
    id: "svc-taxable", name: "Taxable service", price: "100", taxable: true,
  }, "line-taxable-service");
  const exemptProduct = estimateLineFromCatalog("product", {
    id: "product-exempt", name: "Exempt product", price: "50", taxable: false,
  }, "line-exempt-product");

  assert.equal(taxableService.taxable, true);
  assert.equal(exemptProduct.taxable, false);
});

test("missing service cost stays unknown while an explicit zero is a known cost", () => {
  const missing = estimateLineFromCatalog("service", { id: "svc-1", name: "Consultation", price: "100" }, "line-1");
  assert.equal(missing.unitCost, "");
  assert.equal(missing.costKnown, false);

  const free = estimateLineFromCatalog("service", { id: "svc-2", name: "Inspection", price: "50", cost: "0" }, "line-2");
  assert.equal(free.unitCost, "0");
  assert.equal(free.costKnown, true);
});

test("malformed catalog prices and costs stay unknown instead of being coerced", () => {
  const malformed = catalogItemFinancials("part", { retailPer: "1..2", costPer: "." });
  assert.equal(malformed.priceKnown, false);
  assert.equal(malformed.costKnown, false);

  const line = estimateLineFromCatalog("part", { id: "bad", name: "Bad price", retailPer: "1..2", costPer: "." }, "line-bad");
  assert.equal(line.price, "");
  assert.equal(line.unitCost, "");
  assert.equal(line.costKnown, false);

  const negative = catalogItemFinancials("product", { price: "-5", cost: "-1" });
  assert.equal(negative.priceKnown, false);
  assert.equal(negative.costKnown, false);
});

test("catalog lines are immutable snapshots after the source item changes", () => {
  const source = { id: "p1", name: "Pump", price: "400", cost: "250" };
  const line = estimateLineFromCatalog("product", source, "line-1");
  source.name = "Renamed pump";
  source.price = "500";
  source.cost = "300";
  assert.equal(line.desc, "Pump");
  assert.equal(line.price, "400");
  assert.equal(line.unitCost, "250");
});

test("parts bundles snapshot child quantities plus aggregate retail and cost", () => {
  const bundle = estimateLineFromPartsBundle([
    { part: { id: "a", name: "Valve", retailPer: "20", costPer: "8", unit: "piece" }, qty: "2" },
    { part: { id: "b", name: "Clamp", retailPer: "5", costPer: "1.50", unit: "piece" }, qty: "3" },
  ], "bundle-1");

  assert.equal(bundle.price, "55.00");
  assert.equal(bundle.unitCost, "20.50");
  assert.equal(bundle.knownUnitCost, "20.50");
  assert.equal(bundle.costKnown, true);
  assert.equal(bundle.taxable, true);
  assert.equal(bundle.taxabilityMixed, false);
  assert.equal(bundle.chargeType, "parts");
  assert.equal(bundle.bundleItems.length, 2);
  assert.equal(bundle.bundleItems[0].qty, "2");
  assert.match(bundle.desc, /Valve ×2/);
});

test("a mixed-tax parts bundle is flagged so the editor can require separate lines", () => {
  const bundle = estimateLineFromPartsBundle([
    { part: { id: "taxable", name: "Taxable", retailPer: "20", taxable: true }, qty: "1" },
    { part: { id: "exempt", name: "Exempt", retailPer: "5", taxable: false }, qty: "1" },
  ], "bundle-mixed-tax");

  assert.equal(bundle.taxable, false);
  assert.equal(bundle.taxabilityMixed, true);
  assert.deepEqual(bundle.bundleItems.map((item) => item.taxable), [true, false]);
});

test("a bundle with any missing child cost keeps profit incomplete", () => {
  const bundle = estimateLineFromPartsBundle([
    { part: { id: "a", name: "Known", retailPer: "20", costPer: "8" }, qty: "1" },
    { part: { id: "b", name: "Unknown", retailPer: "5" }, qty: "1" },
  ], "bundle-2");
  assert.equal(bundle.price, "25.00");
  assert.equal(bundle.unitCost, "");
  assert.equal(bundle.knownUnitCost, "8.00");
  assert.equal(bundle.costKnown, false);
  assert.equal(bundle.bundleItems[1].costKnown, false);
});

test("a bundle remembers when any child retail price is missing instead of treating it as free", () => {
  const bundle = estimateLineFromPartsBundle([
    { part: { id: "a", name: "Priced", retailPer: "20", costPer: "8" }, qty: "1" },
    { part: { id: "b", name: "Needs retail", retailPer: "", costPer: "2" }, qty: "1" },
  ], "bundle-missing-retail");

  assert.equal(bundle.retailComplete, false);
  assert.equal(bundle.bundleItems[0].priceKnown, true);
  assert.equal(bundle.bundleItems[1].priceKnown, false);
  assert.equal(bundle.bundleItems[1].unitPrice, "");
});

test("a malformed selected part quantity blocks the whole bundle instead of dropping that part", () => {
  const bundle = estimateLineFromPartsBundle([
    { part: { id: "a", name: "Valve", retailPer: "20", costPer: "8" }, qty: "1..2" },
    { part: { id: "b", name: "Clamp", retailPer: "5", costPer: "2" }, qty: "1" },
  ], "bundle-bad-qty");
  assert.equal(bundle, null);
});

test("inventory metadata reports tracked stock without changing it", () => {
  const financials = catalogItemFinancials("part", { costPer: "1", retailPer: "3", unit: "piece", stockByLoc: { shop: "4", truck: 2 } });
  assert.equal(financials.inventoryTracked, true);
  assert.equal(financials.onHand, 6);

  const emptyProduct = catalogItemFinancials("product", { price: "10", cost: "4", stockByLoc: {} });
  assert.equal(emptyProduct.inventoryTracked, true);
  assert.equal(emptyProduct.onHand, 0);

  const migratedPart = catalogItemFinancials("part", { retailPer: "5", costPer: "2", inventoryOz: "9", stockByLoc: {} });
  assert.equal(migratedPart.onHand, 0, "an explicit location map is authoritative, matching app inventory totals");
});
