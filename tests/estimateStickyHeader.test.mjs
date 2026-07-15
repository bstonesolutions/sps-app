import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("mobile estimate detail owns a flush scroll edge while the list keeps its spacing", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function EstimateForm");
  const end = app.indexOf("function BatchInvoiceModal", start);
  const source = app.slice(start, end);

  assert.match(source, /data-estimate-sticky-header/);
  assert.match(source, /position: "sticky", top: 0, zIndex: 40/);
  assert.match(source, /margin: vp\.isPhone \? "0 -16px" : 0/);
  assert.match(source, /padding: vp\.isPhone \? "8px 16px 10px" : "8px 0 10px"/);
  assert.match(source, /background: T\.bg/);

  const screenStart = app.indexOf("function EstimatesScreen");
  const screenSource = app.slice(screenStart, start);
  assert.match(screenSource, /data-estimates-list/);
  assert.match(screenSource, /paddingTop: vp\.isPhone \? 22 : 0/);

  assert.match(app, /const isEstimatesRoute = page === "estimates"/);
  assert.match(app, /vp\.isPhone \? `\$\{isEstimatesRoute \? 0 : 22\}px 16px`/);
});
