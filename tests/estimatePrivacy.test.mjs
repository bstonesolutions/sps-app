import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");
const forbidden = [
  "cost", "unitCost", "knownUnitCost", "costAmount", "costKnown", "refId", "bundleItems",
  "estimatedCost", "estimatedProfit", "estimatedMargin", "costComplete", "missingCostLines",
  "missingCostLineIds", "catalogSnapshot", "stockByLoc", "onHand", "inventoryOz",
];

test("the client portal estimate allowlist keeps units but excludes internal catalog and profit fields", async () => {
  const source = await read("api/portal-data.js");
  const start = source.indexOf("function publicEstimateItem");
  const end = source.indexOf("function estimateMoneyNumber", start);
  assert.ok(start >= 0 && end > start);
  const allowlist = source.slice(start, end);
  assert.match(allowlist, /"unit"/);
  assert.match(allowlist, /"bundleNote"/);
  forbidden.forEach((field) => assert.doesNotMatch(allowlist, new RegExp(`\\b${field}\\b`)));
});

test("estimate email and app payloads carry customer units without carrying costs or profit", async () => {
  const [app, endpoint] = await Promise.all([read("App.jsx"), read("api/send-estimate.js")]);
  const payloadMatch = app.match(/items:\s*\(current\.items \|\| \[\]\)\.map\(it => \(\{([^}]+)\}\)\)/);
  assert.ok(payloadMatch, "estimate email item serializer should stay explicit");
  assert.match(payloadMatch[1], /unit:\s*it\.unit/);
  assert.match(payloadMatch[1], /bundleNote:\s*it\.bundleNote/);
  forbidden.forEach((field) => assert.doesNotMatch(payloadMatch[1], new RegExp(`\\b${field}\\b`)));
  forbidden.forEach((field) => assert.doesNotMatch(endpoint, new RegExp(`\\b${field}\\b`)));
  assert.match(endpoint, /estimateLineQuantity/);
});
