import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../BillingReviewQueue.jsx", import.meta.url), "utf8");
const compiled = await transform(source, { loader: "jsx", format: "esm" });
const code = compiled.code
  .replace('from "react"', `from ${JSON.stringify(pathToFileURL(require.resolve("react")).href)}`)
  .replace('from "./invoiceListView.js"', `from ${JSON.stringify(new URL("../invoiceListView.js", import.meta.url).href)}`);
const { default: Queue } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const render = props => renderToStaticMarkup(React.createElement(Queue, props));
const review = overrides => ({
  id: "review-1", recordType: "billing-review", reviewState: "pending", clientName: "Cedar House", reviewRevision: 1,
  lineItems: [{ desc: "Pond maintenance", qty: 1, unitPrice: 250, serviceDate: "09/28/2026" }],
  ...overrides,
});

test("billing queue only exposes unconfirmed work and keeps former invoice numbers out of the display", () => {
  const html = render({ reviews: [
    review({ number: "INV-OLD-99" }),
    review({ id: "internal-claim", recordType: "invoice-number-claim", clientName: "Hidden Internal Claim", reviewState: "pending" }),
    review({ id: "approval-1", clientName: "Willow House", reviewState: "approving", approval: { invoiceId: "reserved" } }),
    review({ id: "synced-1", clientName: "Hidden Synced Client", reviewState: "synced" }),
    review({ id: "discarded-1", clientName: "Hidden Discarded Client", reviewState: "discarded" }),
  ], totalOf: () => ({ total: 264.15 }), onEdit() {} });
  assert.match(html, /Cedar House/);
  assert.match(html, /Willow House/);
  assert.match(html, /Awaiting review/);
  assert.match(html, /Sync needs attention/);
  assert.doesNotMatch(html, /Hidden Synced|Hidden Discarded|Hidden Internal Claim|INV-OLD-99/);
  assert.match(html, /\$264\.15/);
});

test("service dates come from work evidence and never silently use the planned issue date", () => {
  const html = render({ reviews: [review({ date: "11/01/2026" })], onEdit() {} });
  assert.match(html, /Sep 28, 2026/);
  assert.doesNotMatch(html, /Nov 1, 2026/);
  assert.match(html, /Amount not set/);
  const unknown = render({ reviews: [review({ date: "11/01/2026", lineItems: [] })], onEdit() {} });
  assert.match(unknown, /Service date not set/);
  const month = render({ reviews: [review({ serviceMonth: "2026-04" })], onEdit() {} });
  assert.match(month, /April 2026/);
});

test("search finds later line descriptions and empty results keep existing errors visible", () => {
  const item = review({ lineItems: [{ desc: "Pond maintenance" }, { desc: "Replacement pump" }] });
  const matched = render({ reviews: [item], search: "cedar pump", onEdit() {} });
  assert.match(matched, /data-review-id="review-1"/);
  const empty = render({ reviews: [item], search: "pool cover", error: "Your reviews could not be refreshed.", onEdit() {} });
  assert.match(empty, /No billing reviews match your search/);
  assert.match(empty, /role="alert"/);
  assert.match(empty, /Your reviews could not be refreshed/);
  assert.doesNotMatch(empty, /data-review-id=/);
});

test("rendering the queue never invokes migration or refresh and shows their supplied receipts", () => {
  let callbacks = 0;
  const html = render({ reviews: [], onRefresh() { callbacks += 1; }, onMigrate() { callbacks += 1; }, migrationBusy: true,
    migrationSummary: { movedCount: 3, skippedCount: 2 }, vp: { isPhone: true } });
  assert.equal(callbacks, 0);
  assert.match(html, /Moving job drafts/);
  assert.match(html, /3 job drafts moved to billing review\. 2 invoices kept\./);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(render({ reviews: [] }), /Move unsynced job drafts|Refresh billing reviews/);
});
