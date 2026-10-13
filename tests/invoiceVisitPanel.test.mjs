import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const require = createRequire(import.meta.url);
const reactUrl = pathToFileURL(require.resolve("react")).href;
const panelSource = await readFile(new URL("../InvoiceVisitPanel.jsx", import.meta.url), "utf8");
const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const transformed = await transform(panelSource, { loader: "jsx", format: "esm" });
const panelCode = transformed.code
  .replace('from "react"', `from ${JSON.stringify(reactUrl)}`)
  .replace('from "./invoiceVisitDetails.js"', `from ${JSON.stringify(new URL("../invoiceVisitDetails.js", import.meta.url).href)}`)
  .replace('import "./invoiceVisitPanel.css";', "");
const panelUrl = `data:text/javascript;base64,${Buffer.from(panelCode).toString("base64")}`;
const { default: Panel } = await import(panelUrl);
const T = { primary: "#AF011A", text: "#1D1D1F", textMuted: "#696970", border: "#DDDDDF", surface: "#fff", surfaceAlt: "#F5F5F7" };
const visit = overrides => ({
  sid: "stop-1", completionReceiptId: "receipt-1", date: "10/07/2026", type: "Repair visit", tech: "David",
  notes: "Inspected the waterfall and reseated the pipe", officeNotes: "Confirm warranty before billing",
  services: [{ name: "Repair visit" }],
  treatmentsUsed: [{ name: "Stress Coat", oz: 8, unit: "oz" }],
  partsUsed: [{ name: "Included fitting", qty: 1, bill: false }, { name: "Legacy part", qty: 1 }],
  productsPurchased: [{ name: "Replacement valve", qty: 1, bill: true }],
  ...overrides,
});
const linkedInvoice = { id: "invoice-1", clientId: "client-1", sourceStopId: "stop-1", sourceCompletionReceiptId: "receipt-1", lineItems: [] };
const render = (props = {}) => renderToStaticMarkup(React.createElement(Panel, {
  invoice: linkedInvoice, client: { id: "client-1", history: [visit()] }, T, ...props,
}));

// This uses the actual staff wrapper too. Its thumbnail renderer has historically
// received legacy photo metadata as well as correctly shaped current records.
const wrapperStart = appSource.indexOf("function InvoiceVisitEvidence(");
const wrapperEnd = appSource.indexOf("function InvoiceEditor(", wrapperStart);
const wrapperSource = `
  import React, { useState, useEffect } from ${JSON.stringify(reactUrl)};
  import InvoiceVisitPanel from ${JSON.stringify(panelUrl)};
  const useApp = () => ({ T: ${JSON.stringify(T)} });
  const ProtectedImage = props => React.createElement("img", props);
  const PhotoViewer = () => null;
  const createPortal = child => child;
  ${appSource.slice(wrapperStart, wrapperEnd)}
  export default InvoiceVisitEvidence;
`;
const wrapperCompiled = await transform(wrapperSource, { loader: "jsx", format: "esm" });
const { default: Evidence } = await import(`data:text/javascript;base64,${Buffer.from(wrapperCompiled.code).toString("base64")}`);

test("staff visit evidence keeps the saved work and all three billing states distinct", () => {
  const html = render();
  assert.match(html, /Inspected the waterfall and reseated the pipe/);
  assert.match(html, /Confirm warranty before billing/);
  assert.match(html, /Stress Coat/);
  assert.match(html, /Treatment · 8 oz/);
  assert.match(html, /Usage recorded/);
  assert.match(html, /Billing not recorded/);
  assert.match(html, /Included fitting/);
  assert.match(html, /Do not charge/);
  assert.match(html, /Replacement valve/);
  assert.match(html, /Marked billable/);
  assert.match(html, /Linked visit/);
  assert.match(html, /Internal only/);
  assert.doesNotMatch(html, /Send to client|Charge client|Already billed/);
});

test("unlinked client history is labeled separately and viewing never mutates the invoice or visit", () => {
  const invoice = structuredClone({ ...linkedInvoice, sourceStopId: "", sourceCompletionReceiptId: "" });
  const client = { id: "client-1", history: [visit()] };
  const before = JSON.stringify({ invoice, client });
  const html = render({ invoice, client });
  assert.match(html, /No visit linked/);
  assert.match(html, /Browse client visits/);
  assert.match(html, /This visit is not linked to this invoice/);
  assert.match(html, /Opening a visit here does not add it or its charges to the invoice/);
  assert.doesNotMatch(html, />Linked visit</);
  assert.equal(JSON.stringify({ invoice, client }), before);
});

test("wrong-client visit details and private notes are never rendered", () => {
  const html = render({ client: { id: "other-client", history: [visit({ notes: "PRIVATE WRONG CLIENT NOTE" })] } });
  assert.match(html, /could not be verified/);
  assert.doesNotMatch(html, /PRIVATE WRONG CLIENT NOTE|Stress Coat|Confirm warranty before billing/);
});

test("malformed saved report fields cannot crash the panel or invent work", () => {
  const html = render({ client: { id: "client-1", history: [null, false, "legacy text", visit({
    notes: { unexpected: true }, officeNotes: ["not a note"], services: [null, false, { name: {} }],
    treatmentsUsed: [null, false, { name: {} }], partsUsed: "bad", productsPurchased: [{ name: "Valid item", bill: "false" }],
    productsUsed: [null, { name: {} }], readings: { pH: "7.4", invalid: { raw: "not a reading" }, absent: null },
    checklist: [null, false, {}, { text: "Checked skimmer", done: false }], photos: [null, false, { src: {} }],
  })] } });
  assert.match(html, /No work notes were saved/);
  assert.match(html, /Valid item/);
  assert.match(html, /Billing not recorded/);
  assert.match(html, /Not completed/);
  assert.match(html, /7\.4/);
  assert.doesNotMatch(html, /\[object Object\]|not a reading|not a note|>Do not charge</);
});

test("staff thumbnail rendering tolerates malformed legacy photo labels and captions", () => {
  const client = { id: "client-1", history: [visit({ photos: [
    { src: "data:image/png;base64,AA==", label: { legacy: "Before" }, caption: { legacy: "caption" } },
    { src: "data:image/png;base64,AA==", label: "After", caption: "Repaired pipe" },
    null,
  ] })] };
  const html = renderToStaticMarkup(React.createElement(Evidence, { invoice: linkedInvoice, client }));
  assert.match(html, /Visit photos/);
  assert.match(html, /After/);
  assert.match(html, /Repaired pipe/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("photo metadata keeps numeric capture times usable while rejecting malformed display fields", () => {
  const capturedAt = Date.parse("2026-10-07T14:30:00Z");
  let displayedPhotos;
  render({ client: { id: "client-1", history: [visit({ photos: [
    { src: "data:image/png;base64,AA==", label: { raw: "Before" }, caption: [], takenAt: capturedAt },
  ] })] }, renderPhotos: photos => { displayedPhotos = photos; return null; } });
  assert.equal(displayedPhotos.length, 1);
  assert.equal(displayedPhotos[0].label, "");
  assert.equal(displayedPhotos[0].caption, "");
  assert.equal(new Date(displayedPhotos[0].takenAt).getTime(), capturedAt);
});

test("internal evidence is outside the shared customer document and customer invoice portal", async () => {
  const invoiceDocument = appSource.slice(appSource.indexOf("function InvoiceDocument("), appSource.indexOf("async function exportInvoicePdf("));
  const customerPortal = appSource.slice(appSource.indexOf("function CPInvoices("), appSource.indexOf("function CP", appSource.indexOf("function CPInvoices(") + 1));
  assert.ok(invoiceDocument.includes("InvoiceDocument"));
  assert.ok(customerPortal.includes("InvoiceDocument"));
  assert.doesNotMatch(invoiceDocument, /InvoiceVisitEvidence|InvoiceVisitPanel|officeNotes|treatmentsUsed/);
  assert.doesNotMatch(customerPortal, /InvoiceVisitEvidence|InvoiceVisitPanel|officeNotes/);
  const css = await readFile(new URL("../invoiceVisitPanel.css", import.meta.url), "utf8");
  assert.match(css, /@media print\s*\{\s*\.iv-visit-panel\s*\{\s*display:\s*none\s*!important/);
});
