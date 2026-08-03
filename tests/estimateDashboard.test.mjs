import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("estimate dashboard uses one canonical count and dollar pipeline for every summary tile", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function EstimatesScreen");
  const end = app.indexOf("function EstimateForm", start);
  const screen = app.slice(start, end);

  assert.match(app, /estimatePipelineSummary, estimateProfitTotals/);
  assert.match(screen, /const pipeline = estimatePipelineSummary\(est, invoicing\?\.taxRate\)/);
  assert.match(screen, /data-estimate-pipeline-summary/);
  assert.match(screen, /label: "In progress", bucket: pipeline\.active, sub: "Draft \+ sent", filterId: "active"/);
  assert.match(screen, /label: "Approved", bucket: pipeline\.approved, sub: "Client accepted", filterId: "approved"/);
  assert.match(screen, /label: "All estimates", bucket: pipeline\.total, sub: "Every status", filterId: "all"/);
  assert.match(screen, /bucket\.count/);
  assert.match(screen, /formatEstimateMoney\(bucket\.amount\)/);
  assert.match(screen, /aria-pressed=\{selected\}/);
  assert.match(screen, /fontVariantNumeric: "tabular-nums"/);
  assert.doesNotMatch(screen, /textOverflow: "ellipsis" \}\>\{formatEstimateMoney\(bucket\.amount\)\}/);
  assert.match(screen, /const status = estimatePipelineStatus\(estimate\)/);
  assert.doesNotMatch(screen, /display: vp\.isPhone && index === 2 \? "none"/);
});
