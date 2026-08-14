import test from "node:test";
import assert from "node:assert/strict";

import {
  groupInventoryProductFamilies,
  inventoryProductDisplayName,
  inventoryProductFamilyId,
  inventoryVariantChildId,
  upsertSupplierVariantProducts,
} from "../inventoryProductVariants.js";

const supplierPreview = {
  title: "90 Degree Elbow",
  vendor: "Pipe Manufacturer",
  canonicalUrl: "https://supplier.example/products/90-elbow",
  currency: "USD",
  variants: [
    { id: "gid://shopify/ProductVariant/15", title: "1.5 inch", sku: "ELBOW-15", price: "8.25", available: true },
    { id: "gid://shopify/ProductVariant/20", title: "2 inch", sku: "ELBOW-20", price: "11.5", available: true },
    { id: "gid://shopify/ProductVariant/30", title: "3 inch", sku: "ELBOW-30", price: "19.75", available: false },
  ],
};

test("legacy flat products remain singleton families without changing their records", () => {
  const flat = { id: "p1", name: "Pump", sku: "PUMP-1", stockByLoc: { shed: 2 } };
  const grouped = groupInventoryProductFamilies([flat]);
  assert.equal(inventoryProductFamilyId(flat), "p1");
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].familyId, "p1");
  assert.equal(grouped[0].isVariantFamily, false);
  assert.equal(grouped[0].products[0], flat);
});

test("variant families group children while retaining exact child IDs", () => {
  const children = [
    { id: "p15", productFamilyId: "elbow", familyName: "90 Degree Elbow", variantLabel: "1.5 inch", sku: "ELBOW-15" },
    { id: "p20", productFamilyId: "elbow", familyName: "90 Degree Elbow", variantLabel: "2 inch", sku: "ELBOW-20" },
  ];
  const grouped = groupInventoryProductFamilies(children, "2 inch");
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].name, "90 Degree Elbow");
  assert.equal(grouped[0].isVariantFamily, true);
  assert.deepEqual(grouped[0].products.map((item) => item.id), ["p15", "p20"]);
  assert.equal(inventoryProductDisplayName(children[1]), "90 Degree Elbow · 2 inch");
});

test("manual size variants keep independent retail, cost, and stock under one product family", () => {
  const variants = [
    {
      id: "manual-elbow-15",
      productFamilyId: "manual-elbow",
      familyName: "90 Degree Elbow",
      variantLabel: "1.5 inch",
      name: "90 Degree Elbow · 1.5 inch",
      price: "8.25",
      cost: "4.10",
      stockByLoc: { shed: 18, truck: 2 },
    },
    {
      id: "manual-elbow-20",
      productFamilyId: "manual-elbow",
      familyName: "90 Degree Elbow",
      variantLabel: "2 inch",
      name: "90 Degree Elbow · 2 inch",
      price: "11.50",
      cost: "6.50",
      stockByLoc: { shed: 9, truck: 1 },
    },
    {
      id: "manual-elbow-30",
      productFamilyId: "manual-elbow",
      familyName: "90 Degree Elbow",
      variantLabel: "3 inch",
      name: "90 Degree Elbow · 3 inch",
      price: "19.75",
      cost: "10.20",
      stockByLoc: { shed: 4 },
    },
  ];
  const grouped = groupInventoryProductFamilies(variants);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].familyName, "90 Degree Elbow");
  assert.deepEqual(grouped[0].products.map(({ id, price, cost, stockByLoc }) => ({ id, price, cost, stockByLoc })), [
    { id: "manual-elbow-15", price: "8.25", cost: "4.10", stockByLoc: { shed: 18, truck: 2 } },
    { id: "manual-elbow-20", price: "11.50", cost: "6.50", stockByLoc: { shed: 9, truck: 1 } },
    { id: "manual-elbow-30", price: "19.75", cost: "10.20", stockByLoc: { shed: 4 } },
  ]);
});

test("supplier imports create stable flat children with one shared family", () => {
  const first = upsertSupplierVariantProducts({
    preview: supplierPreview,
    template: { id: "legacy-elbow", category: "Fittings", vendor: "Practical Garden Ponds" },
  });
  const second = upsertSupplierVariantProducts({
    preview: supplierPreview,
    template: { id: "legacy-elbow", category: "Fittings", vendor: "Practical Garden Ponds" },
  });

  assert.equal(first.imported.length, 3);
  assert.equal(new Set(first.imported.map((item) => item.productFamilyId)).size, 1);
  assert.deepEqual(first.imported.map((item) => item.id), second.imported.map((item) => item.id));
  assert.deepEqual(first.imported.map((item) => item.name), [
    "90 Degree Elbow · 1.5 inch",
    "90 Degree Elbow · 2 inch",
    "90 Degree Elbow · 3 inch",
  ]);
  assert.deepEqual(first.imported.map((item) => item.price), ["8.25", "11.50", "19.75"]);
  assert.ok(first.imported.every((item) => item.vendor === "Practical Garden Ponds"));
  assert.ok(first.imported.every((item) => item.category === "Fittings"));
  assert.ok(first.imported.every((item) => item.cost === ""));
  assert.ok(first.imported.every((item) => Object.keys(item.stockByLoc).length === 0));
});

test("refresh updates public retail but preserves each child's cost, stock, and ID", () => {
  const saved = [
    {
      id: "saved-15",
      name: "90 Degree Elbow · 1.5 inch",
      productFamilyId: "elbow-family",
      familyName: "90 Degree Elbow",
      variantLabel: "1.5 inch",
      sourceVariantId: "gid://shopify/ProductVariant/15",
      sku: "ELBOW-15",
      price: "7.00",
      cost: "4.10",
      stockByLoc: { shed: 9, truck: 2 },
      vendor: "Practical Garden Ponds",
    },
  ];
  const refreshed = upsertSupplierVariantProducts({
    preview: supplierPreview,
    products: saved,
    template: saved[0],
    variantIds: ["gid://shopify/ProductVariant/15"],
  });
  const child = refreshed.imported[0];
  assert.equal(child.id, "saved-15");
  assert.equal(child.price, "8.25");
  assert.equal(child.cost, "4.10");
  assert.deepEqual(child.stockByLoc, { shed: 9, truck: 2 });
  assert.notEqual(child.stockByLoc, saved[0].stockByLoc);
  assert.equal(child.vendor, "Practical Garden Ponds");
});

test("reimporting every supplier option is idempotent and preserves each child's private values", () => {
  const initial = upsertSupplierVariantProducts({
    preview: supplierPreview,
    template: { id: "legacy-elbow", category: "Fittings", vendor: "Practical Garden Ponds" },
  });
  const saved = initial.products.map((item, index) => ({
    ...item,
    cost: ["4.10", "6.50", "10.20"][index],
    stockByLoc: { shed: [18, 9, 4][index] },
  }));
  const refreshedPreview = {
    ...supplierPreview,
    variants: supplierPreview.variants.map((variant, index) => ({
      ...variant,
      price: ["8.50", "12.00", "20.25"][index],
    })),
  };
  const refreshed = upsertSupplierVariantProducts({
    preview: refreshedPreview,
    products: saved,
    template: saved[1],
  });

  assert.equal(refreshed.products.length, 3);
  assert.equal(new Set(refreshed.products.map((item) => item.id)).size, 3);
  assert.deepEqual(refreshed.imported.map((item) => item.id), saved.map((item) => item.id));
  assert.deepEqual(refreshed.imported.map((item) => item.price), ["8.50", "12.00", "20.25"]);
  assert.deepEqual(refreshed.imported.map((item) => item.cost), ["4.10", "6.50", "10.20"]);
  assert.deepEqual(refreshed.imported.map((item) => item.stockByLoc), [
    { shed: 18 },
    { shed: 9 },
    { shed: 4 },
  ]);
});

test("a targeted import never repurposes another existing variant or moves its stock", () => {
  const oneAndHalf = {
    id: "saved-15",
    productFamilyId: "elbow-family",
    familyName: "90 Degree Elbow",
    variantLabel: "1.5 inch",
    sourceVariantId: "gid://shopify/ProductVariant/15",
    sku: "ELBOW-15",
    price: "8.25",
    cost: "4.10",
    stockByLoc: { shed: 9 },
  };
  const result = upsertSupplierVariantProducts({
    preview: supplierPreview,
    products: [oneAndHalf],
    template: oneAndHalf,
    variantIds: ["gid://shopify/ProductVariant/20"],
  });

  assert.equal(result.products.length, 2);
  assert.equal(result.products.find((item) => item.id === "saved-15")?.sourceVariantId, "gid://shopify/ProductVariant/15");
  assert.deepEqual(result.products.find((item) => item.id === "saved-15")?.stockByLoc, { shed: 9 });
  const importedTwoInch = result.imported[0];
  assert.notEqual(importedTwoInch.id, "saved-15");
  assert.equal(importedTwoInch.sourceVariantId, "gid://shopify/ProductVariant/20");
  assert.equal(importedTwoInch.cost, "");
  assert.deepEqual(importedTwoInch.stockByLoc, {});
});

test("supplier source variant identity keeps child ID stable if title, SKU, and retail change", () => {
  const familyId = "elbow-family";
  const sourceVariantId = "gid://shopify/ProductVariant/20";
  const before = inventoryVariantChildId({ familyId, sourceVariantId, sku: "ELBOW-20", title: "2 inch" });
  const after = inventoryVariantChildId({ familyId, sourceVariantId, sku: "NEW-SKU", title: "2 inch fitting" });
  assert.equal(after, before);
});

test("converting a stocked legacy item never duplicates its stock or cost across siblings", () => {
  const legacy = {
    id: "legacy-elbow",
    name: "90 Degree Elbow",
    sku: "ELBOW-20",
    cost: "6.50",
    stockByLoc: { shed: 12 },
    vendor: "Practical Garden Ponds",
  };
  const result = upsertSupplierVariantProducts({ preview: supplierPreview, products: [legacy], template: legacy });
  const stocked = result.imported.filter((item) => Object.keys(item.stockByLoc).length);
  assert.equal(stocked.length, 1);
  assert.equal(stocked[0].sku, "ELBOW-20");
  assert.equal(stocked[0].id, "legacy-elbow");
  assert.equal(stocked[0].cost, "6.50");
  assert.equal(result.imported.filter((item) => item.cost === "6.50").length, 1);
});

test("foreign-currency preview cannot overwrite retail and never populates cost", () => {
  const existing = {
    id: "existing",
    productFamilyId: "family",
    familyName: "90 Degree Elbow",
    variantLabel: "2 inch",
    sourceVariantId: "gid://shopify/ProductVariant/20",
    price: "12.00",
    cost: "5.00",
    stockByLoc: { shed: 1 },
  };
  const result = upsertSupplierVariantProducts({
    preview: { ...supplierPreview, currency: "CAD" },
    products: [existing],
    template: existing,
    variantIds: ["gid://shopify/ProductVariant/20"],
  });
  assert.equal(result.imported[0].price, "12.00");
  assert.equal(result.imported[0].cost, "5.00");
});

test("deterministic IDs include family identity to prevent cross-family collisions", () => {
  const left = inventoryVariantChildId({ familyId: "family-a", sourceVariantId: "variant-1" });
  const again = inventoryVariantChildId({ familyId: "family-a", sourceVariantId: "variant-1" });
  const right = inventoryVariantChildId({ familyId: "family-b", sourceVariantId: "variant-1" });
  assert.equal(left, again);
  assert.notEqual(left, right);
});
