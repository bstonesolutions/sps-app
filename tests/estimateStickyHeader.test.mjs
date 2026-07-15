import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("mobile estimate toolbar covers the scroll container's padded top edge", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function EstimateForm");
  const end = app.indexOf("function BatchInvoiceModal", start);
  const source = app.slice(start, end);

  assert.match(source, /data-estimate-sticky-header/);
  assert.match(source, /position: "sticky", top: 0, zIndex: 40/);
  assert.match(source, /margin: vp\.isPhone \? "-22px -16px 0" : 0/);
  assert.match(source, /padding: vp\.isPhone \? "8px 16px 10px" : "8px 0 10px"/);
  assert.match(source, /background: T\.bg/);
});
