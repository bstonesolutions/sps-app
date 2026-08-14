import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../App.jsx", import.meta.url), "utf8");

const component = (source, startToken, endToken) => {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `${startToken} must remain a bounded component`);
  return source.slice(start, end);
};

test("inventory presents variant children under one family and supports manual variants", async () => {
  const app = await readApp();
  const inventory = component(app, "function InventoryScreen", "function ReportsScreen");

  assert.match(inventory, /groupInventoryProductFamilies\(sourceItems\)/);
  assert.match(inventory, /__productFamily: true, family/);
  assert.match(inventory, /data-inventory-product-family/);
  assert.match(inventory, /family\.familyName/);
  assert.match(inventory, /family\.products\.length[^\n]*variants/);
  assert.match(inventory, /const openAddVariant = \(family\) =>/);
  assert.match(inventory, /productFamilyId: family\.familyId/);
  assert.match(inventory, /familyName: family\.familyName/);
  assert.match(inventory, /variantLabel: ""/);
  assert.match(inventory, /onClick=\{\(\) => openAddVariant\(family\)\}/);
  assert.match(inventory, />\+ Variant<\/button>/);
});

test("inventory categories use accessible disclosures with useful stock context", async () => {
  const app = await readApp();
  const inventory = component(app, "function InventoryScreen", "function ReportsScreen");
  const disclosureStart = inventory.indexOf("const visible =");
  const disclosureEnd = inventory.indexOf("if (it.__productFamily)", disclosureStart);

  assert.ok(disclosureStart >= 0 && disclosureEnd > disclosureStart, "the Inventory category disclosure flow must remain inspectable");
  const disclosure = inventory.slice(disclosureStart, disclosureEnd);

  assert.match(disclosure, /data-inventory-category=\{g\.cat\}/, "each category disclosure needs a stable UI marker");
  assert.match(disclosure, /aria-expanded=\{!collapsed\}/, "category disclosures must expose their open state to assistive technology");
  assert.match(disclosure, /g\.itemCount(?: \?\? g\.items\.length)?/, "the category summary must retain its item count");
  assert.match(disclosure, /(?:on hand|in stock|stocked)/i, "the collapsed category must summarize stock without making the user open it");
  assert.match(disclosure, /locFilter === "all"/, "the stock summary must honor the selected inventory location");

  assert.doesNotMatch(
    disclosure,
    /background:\s*"transparent"[\s\S]*?borderBottom:[\s\S]*?borderRadius:\s*0[\s\S]*?textTransform:\s*"uppercase"/,
    "category controls must not regress to the old bare uppercase divider",
  );
});

test("inventory can import every supplier option as exact flat child records", async () => {
  const app = await readApp();
  const modal = component(app, "function InventoryItemModal", "function InventoryScreen");
  const inventory = component(app, "function InventoryScreen", "function ReportsScreen");

  assert.match(modal, /onImportVariants/);
  assert.match(modal, /sourcePreview\.variants\.length > 1/);
  assert.match(modal, /const importAllSourceVariants = \(\) =>/);
  assert.match(modal, /onImportVariants\?\.\(\{[\s\S]*?preview: sourcePreview,[\s\S]*?preferredVariantId: sourcePreviewVariantId,[\s\S]*?\}\)/);
  assert.match(modal, /onClick=\{importAllSourceVariants\}/);
  assert.match(modal, /Import all \{sourcePreview\.variants\.length\} options/);
  assert.match(inventory, /const importProductVariants = \(\{ preview, draft, preferredVariantId \}\) =>/);
  assert.match(inventory, /importSupplierProductVariants\(\{ preview, draft: cleanDraft, products: cat\.products \|\| \[\], preferredVariantId \}\)/);
  assert.match(inventory, /products: result\.products/);
  assert.match(inventory, /initialResult\.familyId[^\n]*setFamilyCollapsed\(current => \(\{ \.\.\.current, \[initialResult\.familyId\]: false \}\)\)/);
});

test("Import all validates and sanitizes supplier metadata before inventory mutation", async () => {
  const app = await readApp();
  const inventory = component(app, "function InventoryScreen", "function ReportsScreen");
  const importStart = inventory.indexOf("const importProductVariants");
  const importEnd = inventory.indexOf("const saveItem", importStart);
  const importFlow = inventory.slice(importStart, importEnd);

  assert.match(importFlow, /const source = inventorySourceMetadata\(draft\)/);
  assert.match(importFlow, /if \(!source\.valid\) \{[\s\S]*?return \{ ok: false, error:/);
  assert.match(importFlow, /const cleanDraft = \{ \.\.\.draft, vendor: source\.vendor, sourceUrl: source\.sourceUrl \}/);
  assert.ok(
    importFlow.indexOf("inventorySourceMetadata(draft)") < importFlow.indexOf("setCatalog("),
    "supplier validation must happen before any catalog mutation",
  );
  assert.ok(
    importFlow.indexOf("if (!source.valid)") < importFlow.indexOf("importSupplierProductVariants("),
    "invalid supplier links must be rejected before variant conversion",
  );
});

test("schedule navigates products by category, then family, while quantities stay keyed to exact child IDs", async () => {
  const app = await readApp();
  const stop = component(app, "function CompleteStopModal", "function Schedule(");

  assert.match(stop, /const scheduleProductCategoryGroups = groupByCat\(selectedFirst\(products, item => productsQty\[item\.id\]\)\)/);
  assert.match(stop, /scheduleProductCategoryGroups\.map\(group =>/);
  assert.match(stop, /data-schedule-product-category/);
  assert.match(stop, /const families = groupInventoryProductFamilies\(group\.items, materialSearch\)/);
  assert.match(stop, /data-schedule-product-family/);
  assert.match(stop, /family\.products\.map\(renderProductMaterialRow\)/);
  assert.match(stop, /data-schedule-product-variant=\{variantLabel \|\| undefined\}/);
  assert.match(stop, /key=\{p\.id\}/);
  assert.match(stop, /value=\{productsQty\[p\.id\] \|\| ""\}/);
  assert.match(stop, /\[p\.id\]: e\.target\.value/);
  assert.match(stop, /productBill\[p\.id\]/);
});

test("estimate and invoice catalog groups product families before selecting exact children", async () => {
  const app = await readApp();
  const picker = component(app, "function CatalogPickerSheet", "function QBConnect");

  assert.match(picker, /groupInventoryProductFamilies\(/, "the products tab must collapse sibling variants under one family");
  assert.match(picker, /__productFamily/, "family disclosures must be distinct from selectable child rows");
  assert.match(picker, /data-catalog-product-family/, "the family disclosure needs a stable UI contract");
  assert.match(picker, /expanded \? family\.products : \[\]/, "opening a family must reveal its exact variant children");
  assert.match(picker, /inventoryProductVariantLabel\(/, "child rows must show their variant label instead of another duplicate family name");
  assert.match(picker, /onAddCatalog\(kindOf\(\), it\)/, "selection must keep using the exact flat child record and ID");
});
