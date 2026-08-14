import test from "node:test";
import assert from "node:assert/strict";

import {
  INVENTORY_SOURCE_URL_MAX_LENGTH,
  INVENTORY_VENDOR_MAX_LENGTH,
  inventorySourceMetadata,
  safeInventorySourceUrl,
  validateInventorySourceUrl,
  validateInventoryVendor,
  inventoryVendorSuggestions,
} from "../inventorySource.js";

test("supplier metadata is optional and normalizes human-readable names", () => {
  assert.deepEqual(validateInventoryVendor("  Practical\n Garden   Ponds  "), {
    valid: true,
    value: "Practical Garden Ponds",
    error: "",
  });
  assert.deepEqual(inventorySourceMetadata(), {
    valid: true,
    vendor: "",
    sourceUrl: "",
    hostname: "",
    isSecure: false,
    errors: { vendor: "", sourceUrl: "" },
  });
});

test("collects unique normalized suppliers across every inventory type", () => {
  assert.deepEqual(inventoryVendorSuggestions({
    treatments: [{ vendor: " Practical Garden Ponds " }, { vendor: "Aquascape" }],
    parts: [{ vendor: "practical garden ponds" }, { vendor: "  Atlantic  Water Gardens " }],
    products: [{ vendor: "AQUASCAPE" }, { vendor: "" }, { vendor: 42 }],
    services: [{ vendor: "Service-only supplier" }],
  }), ["Aquascape", "Atlantic Water Gardens", "Practical Garden Ponds"]);
});

test("supplier suggestions tolerate missing and malformed catalog sections", () => {
  assert.deepEqual(inventoryVendorSuggestions(), []);
  assert.deepEqual(inventoryVendorSuggestions({ treatments: null, parts: {}, products: [] }), []);
});

test("supplier URLs accept only full web links and expose a safe canonical value", () => {
  const https = validateInventorySourceUrl("  https://PracticalGardenPonds.com/products/algaecide?size=32oz#details  ");
  assert.equal(https.valid, true);
  assert.equal(https.value, "https://practicalgardenponds.com/products/algaecide?size=32oz#details");
  assert.equal(https.hostname, "practicalgardenponds.com");
  assert.equal(https.isSecure, true);
  assert.equal(safeInventorySourceUrl(https.value), https.value);

  const http = validateInventorySourceUrl("http://example.com/item");
  assert.equal(http.valid, true);
  assert.equal(http.isSecure, false);
});

test("supplier URLs reject executable, local-file, relative, malformed, and credential-bearing links", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///Users/example/secret",
    "www.example.com/item",
    "/products/item",
    "https://exa mple.com/item",
    "https://user:secret@example.com/item",
    "https://example.com/item\nunsafe",
  ]) {
    const result = validateInventorySourceUrl(value);
    assert.equal(result.valid, false, value);
    assert.equal(result.value, "", value);
    assert.equal(safeInventorySourceUrl(value), "", value);
  }
});

test("supplier metadata reports field-specific validation failures without returning an unsafe URL", () => {
  const metadata = inventorySourceMetadata({
    vendor: `A${"b".repeat(INVENTORY_VENDOR_MAX_LENGTH)}`,
    sourceUrl: "javascript:alert(1)",
  });

  assert.equal(metadata.valid, false);
  assert.match(metadata.errors.vendor, /characters or fewer/);
  assert.match(metadata.errors.sourceUrl, /http:\/\/ and https:\/\//);
  assert.equal(metadata.sourceUrl, "");
  assert.equal(metadata.hostname, "");
});

test("supplier fields reject non-text, control characters, and oversized URLs", () => {
  assert.equal(validateInventoryVendor(42).valid, false);
  assert.equal(validateInventoryVendor("Vendor\u0000Name").valid, false);
  assert.equal(validateInventorySourceUrl({ href: "https://example.com" }).valid, false);
  const oversized = `https://example.com/${"a".repeat(INVENTORY_SOURCE_URL_MAX_LENGTH)}`;
  assert.equal(validateInventorySourceUrl(oversized).valid, false);
});
