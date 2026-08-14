import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the stop editor consolidates materials without changing completion accounting", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function CompleteStopModal");
  const end = app.indexOf("function StopChangeModal", start);
  const source = app.slice(start, end);

  assert.match(source, /const \[materialsOpen, setMaterialsOpen\] = useState\(false\)/);
  assert.match(source, /const \[materialsTab, setMaterialsTab\] = useState\("all"\)/);
  assert.match(source, /const \[materialsSearch, setMaterialsSearch\] = useState\(""\)/);
  assert.match(source, /data-sps-stop-materials/);
  assert.match(source, />Materials &amp; stock</);
  assert.match(source, /Search materials or categories/);
  assert.match(source, /\{ id: "treatment", label: "Treatments"/);
  assert.match(source, /\{ id: "part", label: "Parts"/);
  assert.match(source, /\{ id: "product", label: "Products"/);
  assert.match(source, /`\$\{item\.name \|\| ""\} \$\{item\.category \|\| ""\}`/);
  assert.match(source, /selectedFirst\(treatments, item => tx\[item\.id\]\)/);
  assert.match(source, /selectedFirst\(parts, item => partsUsed\[item\.id\]\)/);
  assert.match(source, /selectedFirst\(products, item => productsQty\[item\.id\]\)/);
  assert.match(source, /const here = usageLoc \? invAtLoc\(p, usageLoc\) : invTotal\(p\)/);
  assert.match(source, /const totalAvailable = invTotal\(p\)/);
  assert.match(source, /const insufficient = qty > totalAvailable/);
  assert.match(source, /const usesOtherStock = !!usageLoc && qty > here && !insufficient/);
  assert.match(source, /not enough stock/);
  assert.match(source, /uses other stock/);
  assert.match(source, /This location is used first\. If it is short, completion uses other tracked stock\./);
  assert.match(source, /const selectedLocationSummary = usageLoc \? `\$\{selectedLocationName\} first` : selectedLocationName/);

  assert.match(source, /if \(d\.tx\) setTx\(d\.tx\)/);
  assert.match(source, /if \(d\.partsUsed\) setPartsUsedState\(d\.partsUsed\)/);
  assert.match(source, /if \(d\.productsQty\) setProductsQty\(d\.productsQty\)/);
  assert.match(source, /treatmentsUsed, productsUsed/);
  assert.match(source, /productsPurchased: productsPurchasedArr/);
  assert.match(source, /partsUsed: partsUsedArr/);
  assert.match(source, /usageLoc,/);
});

test("schedule material categories stay closed while browsing and flatten during search", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function CompleteStopModal");
  const end = app.indexOf("function StopChangeModal", start);
  const source = app.slice(start, end);

  assert.match(source, /const collapsed = catCollapsed\[key\] !== false/);
  assert.match(source, /aria-expanded=\{!collapsed\}/);
  assert.match(source, /if \(flat\) return items\.map\(renderRow\)/);
  assert.match(source, /}, !!materialSearch\)\}/);
});
