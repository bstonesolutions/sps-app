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

test("inventory keeps every core control in a compact grouped deck and alert lists closed", async () => {
  const app = await readApp();
  const start = app.indexOf("function InventoryScreen");
  const end = app.indexOf("function ReportsScreen", start);
  const inventory = app.slice(start, end);
  const deckStart = inventory.indexOf("data-inventory-control-deck");
  const deckEnd = inventory.indexOf("{/* Item cards */}", deckStart);

  assert.ok(deckStart >= 0 && deckEnd > deckStart, "Inventory needs one bounded compact control deck");
  const deck = inventory.slice(deckStart, deckEnd);
  assert.ok((deck.match(/data-inventory-control-group=/g) || []).length >= 2, "the deck must group related controls instead of presenting one long toolbar");

  assert.match(deck, />Locations</, "storage locations must remain available");
  assert.match(deck, /\[\["treatments", "Treatments"\], \["parts", "Parts"\], \["products", "Products"\]\]/, "all inventory types must remain directly selectable");
  assert.match(deck, /setLocFilter\("all"\)/, "the all-locations filter must remain available");
  assert.match(deck, /locations\.map\(loc =>/, "individual location filters must remain available");

  const financialMarkers = deck.match(/data-inventory-financial-summary/g) || [];
  assert.equal(financialMarkers.length, 1, "the compact deck must have exactly one financial summary");
  const financialStart = deck.indexOf("data-inventory-financial-summary");
  const financialContext = deck.slice(Math.max(0, financialStart - 500), financialStart + 3000);
  assert.match(financialContext, /\{canSeeCost && \([\s\S]*data-inventory-financial-summary/, "the financial summary must stay hidden from users without cost access");
  assert.match(financialContext, /known cost/i, "the summary must retain known inventory cost");
  assert.match(financialContext, /\{reorderItems\.length\}/, "the summary must retain the reorder count");
  assert.match(financialContext, /aria-expanded=\{[^}]+\}/, "the summary must provide accessible access to its financial details");

  const headingStart = deck.indexOf('data-inventory-control-group="heading"');
  const heading = deck.slice(headingStart, financialStart);
  assert.doesNotMatch(heading, /known cost/i, "the Inventory subtitle must not duplicate the financial summary");

  const scopeStart = deck.indexOf('data-inventory-control-group="scope"');
  const alertsStart = deck.indexOf('data-inventory-control-group="alerts"', scopeStart);
  const scope = deck.slice(scopeStart, alertsStart);
  assert.doesNotMatch(scope, />Total Value<|>Reorder List</, "the scope row must not repeat the financial summary as a second toolbar");

  const assertCollapsedAlert = (marker, stateHint) => {
    const markerToken = `data-inventory-alert="${marker}"`;
    const alertStart = inventory.indexOf(markerToken);
    assert.ok(alertStart >= 0, `${marker} needs a stable alert marker`);
    const alert = inventory.slice(alertStart, alertStart + 5000);
    const closedStates = [...inventory.matchAll(/const \[([A-Za-z_$][\w$]*),\s*[A-Za-z_$][\w$]*\] = useState\(false\)/g)];
    const stateMatch = closedStates.find(match => match[1].toLowerCase().includes(stateHint.toLowerCase()));
    assert.ok(stateMatch, `${marker} must initialize closed`);
    const state = stateMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(alert, new RegExp(`aria-expanded=\\{${state}\\}`), `${marker} must expose its collapsed state`);
    assert.match(inventory, new RegExp(`\\{[^\\n]*\\b${state}\\b[^\\n]*&& \\(`), `${marker} details must render only after disclosure`);
  };

  assertCollapsedAlert("low-stock", "LowStock");
  assertCollapsedAlert("missing-price", "PriceReview");
});
