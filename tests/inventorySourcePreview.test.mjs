import test from "node:test";
import assert from "node:assert/strict";

import { inventorySourcePreviewApplyPatch, normalizeInventorySourcePreview } from "../inventorySourcePreviewClient.js";

test("normalizes only safe public supplier preview fields", () => {
  assert.deepEqual(normalizeInventorySourcePreview({
    product: {
      title: "  Aqua  Pump  ",
      vendor: "  Practical Garden Ponds ",
      canonicalUrl: "https://EXAMPLE.com/pump",
      imageUrl: "javascript:alert(1)",
      currency: "usd",
      variants: [
        { id: "large", title: " Large ", sku: " AP-2 ", price: "129.9", available: true },
        { id: "bad", title: "Bad", sku: "BAD", price: "-40", available: false },
      ],
      cost: "1.00",
      stock: 200,
    },
  }), {
    title: "Aqua Pump",
    vendor: "Practical Garden Ponds",
    canonicalUrl: "https://example.com/pump",
    imageUrl: "",
    currency: "USD",
    variants: [
      { id: "large", title: "Large", sku: "AP-2", price: "129.90", available: true },
      { id: "bad", title: "Bad", sku: "BAD", price: "", available: false },
    ],
  });
});

test("applies only explicitly selected inventory draft fields and never cost", () => {
  const preview = {
    title: "Aqua Pump",
    vendor: "Pond Supplier",
    canonicalUrl: "https://example.com/pump",
    currency: "USD",
    variants: [{ id: "v2", title: "Large", sku: "AP-2", price: "129.90", available: true }],
    cost: "1.00",
  };
  assert.deepEqual(inventorySourcePreviewApplyPatch({
    preview,
    variantId: "v2",
    selected: { vendor: true, sku: true, retail: true },
    retailField: "retailPer",
  }), { vendor: "Pond Supplier", sku: "AP-2", retailPer: "129.90" });
});

test("foreign currency public price is never mapped into retail", () => {
  assert.deepEqual(inventorySourcePreviewApplyPatch({
    preview: { currency: "CAD", variants: [{ id: "v1", price: "50" }] },
    selected: { retail: true },
    retailField: "price",
  }), {});
});

test("unknown destinations and unselected populated values are ignored", () => {
  assert.deepEqual(inventorySourcePreviewApplyPatch({
    preview: { title: "New Name", canonicalUrl: "https://example.com/item", variants: [{ id: "v1", sku: "SKU", price: "10" }] },
    selected: { name: false, sourceUrl: false, sku: false, retail: true, cost: true },
    retailField: "cost",
  }), {});
});
