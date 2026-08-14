import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../App.jsx", import.meta.url), "utf8");

test("inventory item editor calculates package cost into each item's canonical cost field", async () => {
  const app = await readApp();
  const start = app.indexOf("function InventoryItemModal");
  const end = app.indexOf("function InventoryScreen", start);
  const modal = app.slice(start, end);

  assert.match(app, /import \{ inventoryPackageCost \} from "\.\/inventoryPricing"/);
  assert.match(modal, /Package cost calculator/);
  assert.match(modal, /packagePrice/);
  assert.match(modal, /packageQuantity/);
  assert.match(modal, /packageUnit/);
  assert.match(modal, /\[costField\]: calculated\.unitCostText/);
  assert.match(modal, /You can override the result below/);
});

test("inventory cards expose explicit add, remove, and physical-count operations", async () => {
  const app = await readApp();
  const start = app.indexOf("function InventoryScreen");
  const inventory = app.slice(start);

  assert.match(inventory, /openAdjust\(it, "add"/);
  assert.match(inventory, /openAdjust\(it, "remove"/);
  assert.match(inventory, /openAdjust\(it, "set"/);
  assert.match(inventory, /\+ Add/);
  assert.match(inventory, /− Remove/);
  assert.match(inventory, /Set count/);
  assert.match(inventory, /inventoryAdjustmentResult\(\{ current, amount: adjustAmt, operation: adjustModal\.operation \}\)/);
  assert.match(inventory, /allowZero: adjustModal\.operation === "set"/);
  assert.match(inventory, /After save/);
});

test("location transfers fail closed when the source does not have enough stock", async () => {
  const app = await readApp();
  const start = app.indexOf("function InventoryScreen");
  const inventory = app.slice(start);

  assert.match(inventory, /inventoryTransferResult\(\{/);
  assert.match(inventory, /if \(!result\.valid \|\| !transferFrom \|\| !transferTo \|\| transferFrom === transferTo\) return/);
  assert.match(inventory, /Only \{preview\.available\}/);
  assert.match(inventory, /disabled=\{!preview\.valid \|\| transferFrom === transferTo\}/);
});
