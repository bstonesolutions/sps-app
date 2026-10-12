import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "esbuild";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const modal = app.slice(app.indexOf("function CompleteStopModal("), app.indexOf("function AddStopForm("));
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing stop-pricing source boundary: ${start}`);
  return source.slice(from, to);
};
const sourceLine = (source, prefix) => {
  const line = source.split("\n").find(value => value.trim().startsWith(prefix));
  assert.ok(line, `Missing stop-pricing source: ${prefix}`);
  return line;
};

// Compile the actual service initialization, draft assignment, formatter and JSX.
// Keeping this slice narrow avoids mocking the modal's unrelated camera, messaging,
// inventory and completion network integrations while exercising the failing render.
const source = `
import React from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("react")).href)};
import { formatAccountingCurrency } from ${JSON.stringify(new URL("../invoiceAccountingSummary.js", import.meta.url).href)};
${sourceLine(app, "const canSeeInvoiceMoney =")}
${sourceLine(app, "const canManageInvoiceAccounting =")}
export default function StopServicePricing({ stop, perVisitMaintRate = "", draft, perms }) {
  ${between(modal, "const initServices =", "const [svcList, setSvcList]")}
  let svcList = initServices;
  if (draft) {
    const d = draft;
    const setSvcList = value => { svcList = value; };
    ${sourceLine(modal, "if (Array.isArray(d.svcList))")}
  }
  ${sourceLine(modal, "const showStopBilling =")}
  ${sourceLine(modal, "const editStopBilling =")}
  ${sourceLine(modal, "const money =")}
  const T = {}, sectionGap = {}, labelStyle = {};
  const isProrated = false, monthlyMaint = 0, visitsPerMonth = 1;
  const setSvcPrice = () => {};
  return <>${between(modal, "{/* Services —", "{/* Photos —")}</>;
}
`;
const compiled = await transform(source, { loader: "jsx", format: "esm" });
const { default: StopServicePricing } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);
const render = (overrides = {}) => renderToStaticMarkup(React.createElement(StopServicePricing, {
  stop: { type: "Pond maintenance", services: [{ name: "Monthly service", price: "1250.50" }] },
  perms: { seeBalances: true, isAdmin: false, invoiceCreate: false },
  ...overrides,
}));

test("read-only stop billing renders initial string service prices without crashing", () => {
  const html = render();
  assert.match(html, /\$1,250\.50/);
  assert.match(html, /Office-managed service pricing/);
  assert.doesNotMatch(html, /<input/);
});

test("restored draft string prices replace initial prices and remain renderable", () => {
  const html = render({ draft: { svcList: [{ name: "Updated visit", price: "87.65" }] } });
  assert.match(html, /Updated visit/);
  assert.match(html, /\$87\.65/);
  assert.doesNotMatch(html, /1,250\.50|Monthly service/);
});

test("a string maintenance-rate fallback renders for a stop without explicit services", () => {
  const html = render({ stop: { type: "Pool service", services: [] }, perVisitMaintRate: "62.50" });
  assert.match(html, /Pool service/);
  assert.match(html, /\$62\.50/);
});

test("missing or invalid restored prices do not take down the stop editor", () => {
  for (const price of ["", null, undefined, "invalid", "Infinity"]) {
    const html = render({ draft: { svcList: [{ name: "Visit", price }] } });
    assert.match(html, /\$0\.00/);
    assert.doesNotMatch(html, /NaN|Infinity/);
  }
});

test("service-price formatting preserves billing visibility and edit permissions", () => {
  const hidden = render({ perms: {} });
  assert.doesNotMatch(hidden, /1,250\.50|1250\.50|<input/);
  assert.match(hidden, /Service pricing is handled by the office/);
  const editable = render({ perms: { isAdmin: true } });
  assert.match(editable, /<input[^>]*value="1250\.50"/);
  assert.match(editable, /Edit any line for this stop/);
});
