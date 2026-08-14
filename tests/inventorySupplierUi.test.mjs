import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../App.jsx", import.meta.url), "utf8");

test("catalog and inventory editors validate and preserve internal supplier metadata", async () => {
  const app = await readApp();
  const sourceFieldsStart = app.indexOf("function SupplierSourceFields");
  const sourceFieldsEnd = app.indexOf("function CatalogManager", sourceFieldsStart);
  const sourceFields = app.slice(sourceFieldsStart, sourceFieldsEnd);
  const managerEnd = app.indexOf("function BudgetManager", sourceFieldsEnd);
  const manager = app.slice(sourceFieldsEnd, managerEnd);
  const inventoryStart = app.indexOf("function InventoryItemModal");
  const inventoryEnd = app.indexOf("function InventoryScreen", inventoryStart);
  const inventoryModal = app.slice(inventoryStart, inventoryEnd);

  assert.match(app, /import \{ inventorySourceMetadata, inventoryVendorSuggestions(?:, [^}]*)? \} from "\.\/inventorySource"/);
  assert.match(sourceFields, /const source = inventorySourceMetadata\(data\)/);
  assert.match(sourceFields, /role="combobox"/);
  assert.match(sourceFields, /aria-controls=\{vendorListboxId\}/);
  assert.match(sourceFields, /aria-activedescendant=/);
  assert.match(sourceFields, /id=\{vendorListboxId\} role="listbox" aria-label="Past suppliers"/);
  assert.match(sourceFields, /id=\{`\$\{vendorListboxId\}-option-\$\{index\}`\}/);
  assert.match(sourceFields, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(sourceFields, /event\.key === "Enter"/);
  assert.match(sourceFields, /event\.key === "Escape"/);
  assert.match(sourceFields, /onChange\("vendor", event\.target\.value\)/, "supplier input must retain free-text entry");
  assert.match(sourceFields, /openExternalBrowser\(safeSourceUrl\)/);
  assert.match(sourceFields, /Never paste a signed-in checkout, account, or private session link/);
  assert.match(manager, /sourceUrl: ""[\s\S]*?openAddTx/);
  assert.match(manager, /openAddTx[\s\S]*?sourceUrl: ""[\s\S]*?openAddSvc/);
  assert.match(manager, /openAddSvc[\s\S]*?sourceUrl: ""/);
  assert.match(manager, /vendor: source\.vendor, sourceUrl: source\.sourceUrl/g);
  assert.ok((manager.match(/<SupplierSourceFields/g) || []).length >= 3, "product, treatment, and service editors should share safe supplier fields");
  assert.ok((manager.match(/vendorSuggestions=\{supplierSuggestions\}/g) || []).length >= 3, "every catalog supplier editor should reuse past inventory vendors");
  assert.match(inventoryModal, /const source = inventorySourceMetadata\(data\)/);
  assert.match(inventoryModal, /<SupplierSourceFields/);
  assert.match(inventoryModal, /vendorSuggestions=\{vendorSuggestions\}/);
  assert.match(inventoryModal, /disabled=\{!\(data\.name \|\| ""\)\.trim\(\)[\s\S]*?!source\.valid\}/);
});
test("estimate catalog exposes safe supplier links only to inventory-authorized staff", async () => {
  const app = await readApp();
  const start = app.indexOf("function CatalogPickerSheet");
  const end = app.indexOf("function QBConnect", start);
  const picker = app.slice(start, end);

  assert.match(picker, /const supplier = inventorySourceMetadata\(it\)/);
  assert.match(picker, /showInventory && supplier\.valid/);
  assert.match(picker, /data-catalog-supplier/);
  assert.match(picker, /event\.preventDefault\(\); event\.stopPropagation\(\); openExternalBrowser\(supplier\.sourceUrl\)/);
  assert.match(picker, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
});
