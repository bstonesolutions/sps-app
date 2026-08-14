import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("inventory item editor previews public supplier details without auto-saving or importing cost", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function InventoryItemModal");
  const end = app.indexOf("function InventoryScreen", start);
  const modal = app.slice(start, end);

  assert.match(app, /import \{ inventorySourcePreviewApplyPatch, normalizeInventorySourcePreview \} from "\.\/inventorySourcePreviewClient"/);
  assert.match(modal, /fetch\(`\$\{PROD_URL\}\/api\/inventory-source-preview`/);
  assert.match(modal, /headers: await authHeaders\(\{ "Content-Type": "application\/json" \}\)/);
  assert.match(modal, /"Preview public details"/);
  assert.match(modal, />Apply selected<\/button>/);
  assert.match(modal, /Nothing is applied until you check a field and press Apply\. Cost is never imported\./);
  assert.match(modal, /Preview only\. Supplier images are not copied into inventory\./);
  assert.match(modal, /inventorySourcePreviewApplyPatch\(/);
  assert.match(modal, /set\(patch\)/);
  assert.match(modal, /setSourcePreview\(null\);[\s\S]*?setSourcePreviewVariantId\(""\);[\s\S]*?setSourcePreviewChoices\(\{\}\);[\s\S]*?\}, \[data\?\.sourceUrl\]\)/, "changing the supplier URL must dismiss stale preview data and choices");
  assert.doesNotMatch(modal, /sourcePreview[\s\S]*?onSave\(patch\)/);
  assert.doesNotMatch(modal, /selectedSourceVariant[^\n]*cost/);
});
