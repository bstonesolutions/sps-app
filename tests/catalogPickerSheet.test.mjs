import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("catalog picker owns its scroll instead of chaining to the page behind it", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function CatalogPickerSheet");
  const end = app.indexOf("function QBConnect", start);
  const source = app.slice(start, end);

  assert.match(source, /useBackgroundScrollLock\(\)/);
  assert.match(source, /return createPortal\(/);
  assert.match(source, /document\.body/);
  assert.match(source, /role="dialog" aria-modal="true"/);
  assert.match(source, /minHeight: 0[\s\S]*?overflow: "hidden"/);
  assert.match(source, /flex: "1 1 auto"[\s\S]*?minHeight: 0[\s\S]*?overflowY: "auto"/);
  assert.match(source, /WebkitOverflowScrolling: "touch"/);
  assert.match(source, /overscrollBehavior: "contain"/);
  assert.match(source, /touchAction: "pan-y"/);

  const lockStart = app.indexOf("function useBackgroundScrollLock");
  const lockEnd = app.indexOf("function Modal", lockStart);
  const lockSource = app.slice(lockStart, lockEnd);
  assert.match(lockSource, /document\.querySelectorAll\("main, \[data-sps-modal-scroll\]"\)/);
  assert.match(lockSource, /target\.style\.overflow = "hidden"/);
  assert.match(lockSource, /target\.scrollTop = snapshot\.scrollTop/);
  assert.match(app, /data-sps-modal-scroll/);

  assert.equal((app.match(/<CatalogPickerSheet/g) || []).length, 2, "invoice and estimate builders should share the fixed picker");
});

test("the shared estimate catalog picker preserves inventory categories", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function CatalogPickerSheet");
  const end = app.indexOf("function QBConnect", start);
  const source = app.slice(start, end);

  assert.match(app, /import \{ catalogCategoryGroups,/);
  assert.match(source, /catalogCategoryGroups\(pickerItems, search\)/);
  assert.match(source, /findIndex\(\(candidate\) => String\(candidate\?\.id\) === String\(item\?\.id\)\)/);
  assert.match(source, /Search \$\{tab\} or categories/);
  assert.match(source, /collapsedCategories/);
  assert.match(source, /!collapsedCategories\[categoryKey\] \|\| search\.trim\(\)/);
  assert.match(source, /String\(p\.id\) === String\(id\)/);
  assert.match(source, /value=\{newItem\.category\}/);
  assert.match(source, /estimate-catalog-categories-\$\{tab\}/);
  assert.match(source, /matchedCategory[\s\S]*?name: matchedCategory \? "" : search[\s\S]*?category: matchedCategory \? matchedCategory\.category : ""/);

  const managerStart = app.indexOf("function CatalogManager");
  const managerEnd = app.indexOf("function BudgetManager", managerStart);
  const manager = app.slice(managerStart, managerEnd);
  assert.match(manager, /category: ""[\s\S]*?price: ""/);
  assert.match(manager, /list="sps-service-categories"/);
  assert.match(manager, /setSvc\("category", e\.target\.value\)/);
});

test("numeric part ids remain selectable in the bundle picker", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function CatalogPickerSheet");
  const end = app.indexOf("function QBConnect", start);
  const source = app.slice(start, end);

  assert.match(source, /Object\.entries\(bundle\)/);
  assert.match(source, /find\(p => String\(p\.id\) === String\(id\)\)/);
});
