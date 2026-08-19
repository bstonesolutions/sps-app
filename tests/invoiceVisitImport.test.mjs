import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  appendCompletedVisitsToInvoice,
  completedVisitBillableTotal,
  completedVisitInvoiceLink,
  completedVisitInvoiceSaveConflict,
  completedVisitLineItems,
  completedVisitSource,
  invoiceCompletedVisitSources,
  invoiceContainsCompletedVisit,
  legacyCompletedVisitInvoiceMatch,
  removeInvoiceLineAndPruneCompletedVisitSources,
  reserveCompletedVisitInvoice,
} from "../invoiceVisitImport.js";

const visit = (overrides = {}) => ({
  sid: "stop-101",
  completionReceiptId: "receipt-101",
  date: "08/19/2026",
  type: "Repair visit",
  services: [{ id: "service-1", name: "Repair labor", price: "175", cost: "59" }],
  partsUsed: [
    { id: "part-1", name: "Valve", qty: 2, retailPer: 18, costPer: 10, taxable: true },
    { id: "part-office", name: "Office supplied part", qty: 1, retailPer: 20, costPer: 12, bill: false },
  ],
  productsPurchased: [
    { id: "product-1", name: "Pump", qty: 1, price: 200, cost: 125, taxable: false },
    { id: "product-included", name: "Included product", qty: 1, price: 50, cost: 30, bill: false },
  ],
  ...overrides,
});

test("selected completed visits append without erasing existing invoice lines", () => {
  const existing = {
    id: "invoice-1",
    lineItems: [{ id: "custom-1", desc: "Existing custom line", qty: "1", unitPrice: "25", taxable: false }],
  };
  const result = appendCompletedVisitsToInvoice(existing, [visit()], { clientId: "client-1" });

  assert.equal(result.lineItems[0].id, "custom-1");
  assert.equal(result.addedVisitKeys.length, 1);
  assert.equal(result.addedLineCount, 3);
  assert.deepEqual(result.sourceStopIds, ["stop-101"]);
  assert.deepEqual(result.sourceCompletionReceiptIds, ["receipt-101"]);
  assert.deepEqual(result.sourceVisitClientIds, ["client-1"]);
  assert.equal(result.invoice.sourceVisitClientId, "client-1");
  assert.equal(existing.lineItems.length, 1, "the helper must not mutate the original invoice");
});

test("saving cannot move imported visits to another client", () => {
  const imported = appendCompletedVisitsToInvoice(
    { id: "invoice-1", clientId: "client-1", lineItems: [] },
    [visit()],
    { clientId: "client-1" },
  ).invoice;
  const changedClient = { ...imported, clientId: "client-2" };

  assert.equal(completedVisitInvoiceSaveConflict(changedClient, [], [], {
    clientId: "client-2",
  })?.code, "visit-client-mismatch");
});

test("older provenance without a client is upgraded only from that client's history", () => {
  const imported = appendCompletedVisitsToInvoice(
    { id: "invoice-1", clientId: "client-1", lineItems: [] },
    [visit()],
    { clientId: "client-1" },
  ).invoice;
  delete imported.sourceVisitClientId;
  delete imported.sourceVisitClientIds;

  const safe = reserveCompletedVisitInvoice(imported, [], [visit()], { clientId: "client-1" });
  assert.equal(safe.ok, true);
  assert.deepEqual(safe.reservedInvoice.sourceVisitClientIds, ["client-1"]);

  const unsafe = completedVisitInvoiceSaveConflict(
    { ...imported, clientId: "client-2" },
    [],
    [],
    { clientId: "client-2" },
  );
  assert.equal(unsafe?.code, "visit-client-unverified");
});

test("latest shared invoices prevent the same completed visit from being reserved twice", () => {
  const candidate = appendCompletedVisitsToInvoice(
    { id: "invoice-new", clientId: "client-1", lineItems: [] },
    [visit()],
    { clientId: "client-1" },
  ).invoice;
  const other = {
    id: "invoice-existing",
    number: "2051",
    clientId: "client-1",
    sourceStopIds: ["stop-101"],
    sourceCompletionReceiptIds: ["receipt-101"],
    sourceVisitClientIds: ["client-1"],
    lineItems: [],
  };
  const reservation = reserveCompletedVisitInvoice(candidate, [other], [visit()], { clientId: "client-1" });

  assert.equal(reservation.ok, false);
  assert.equal(reservation.conflict.code, "visit-already-linked");
  assert.equal(reservation.conflict.invoiceNumber, "2051");
});

test("reservation preserves the latest accounting record while claiming visit sources", () => {
  const candidate = appendCompletedVisitsToInvoice(
    { id: "invoice-1", clientId: "client-1", notes: "stale note", lineItems: [] },
    [visit()],
    { clientId: "client-1" },
  ).invoice;
  const latest = {
    id: "invoice-1",
    clientId: "client-1",
    notes: "newer note from another device",
    lineItems: [{ id: "remote-line", desc: "Remote line", qty: "1", unitPrice: "10" }],
  };
  const reservation = reserveCompletedVisitInvoice(candidate, [latest], [visit()], { clientId: "client-1" });

  assert.equal(reservation.ok, true);
  assert.equal(reservation.reservedInvoice.notes, "newer note from another device");
  assert.deepEqual(reservation.reservedInvoice.lineItems, latest.lineItems);
  assert.deepEqual(reservation.reservedInvoice.sourceStopIds, ["stop-101"]);
  assert.deepEqual(reservation.reservedInvoice.sourceCompletionReceiptIds, ["receipt-101"]);
  assert.deepEqual(reservation.reservedInvoice.sourceVisitClientIds, ["client-1"]);
});

const legacyInvoiceFor = (sourceVisit, overrides = {}) => ({
  id: "legacy-invoice",
  number: "1900",
  clientId: "client-1",
  lineItems: [
    { id: "old-service", desc: "Repair labor", qty: "1", unitPrice: "175", unitCost: "", taxable: false },
    { id: "old-part", desc: "Valve", qty: "2", unitPrice: "18", unitCost: "10", taxable: true, kind: "part" },
    { id: "old-product", desc: "Pump", qty: "1", unitPrice: "200", unitCost: "125", taxable: true, kind: "product" },
  ],
  ...overrides,
  // Keep this argument in the fixture signature so each test clearly documents the
  // completed visit whose legacy serialization the invoice represents.
  legacyVisitDate: sourceVisit.date,
});

test("an exact old single-visit import is surfaced as a legacy link", () => {
  const sourceVisit = visit();
  const legacyInvoice = legacyInvoiceFor(sourceVisit);
  assert.equal(legacyCompletedVisitInvoiceMatch(legacyInvoice, sourceVisit, { clientId: "client-1" }), true);

  const link = completedVisitInvoiceLink(sourceVisit, [legacyInvoice], {
    clientId: "client-1",
    visits: [sourceVisit],
  });
  assert.equal(link?.legacy, true);
  assert.equal(link?.ambiguous, false);
  assert.equal(link?.invoiceNumber, "1900");
});

test("repeated old visit shapes are marked ambiguous instead of silently attributed", () => {
  const first = visit();
  const repeated = visit({ sid: "stop-102", completionReceiptId: "receipt-102", date: "08/26/2026" });
  const legacyInvoice = legacyInvoiceFor(first);
  const link = completedVisitInvoiceLink(first, [legacyInvoice], {
    clientId: "client-1",
    visits: [first, repeated],
  });

  assert.equal(link?.legacy, true);
  assert.equal(link?.ambiguous, true);

  const candidate = appendCompletedVisitsToInvoice(
    { id: "invoice-new", clientId: "client-1", lineItems: [] },
    [first],
    { clientId: "client-1" },
  ).invoice;
  assert.equal(completedVisitInvoiceSaveConflict(candidate, [legacyInvoice], [first, repeated], {
    clientId: "client-1",
  })?.code, "possible-legacy-visit-link");
});

test("removing the final imported visit line prunes its invoice provenance and client lock", () => {
  const imported = appendCompletedVisitsToInvoice(
    { id: "invoice-1", clientId: "client-1", lineItems: [] },
    [visit({ services: [], partsUsed: [], productsPurchased: [{ id: "only", name: "Pump", qty: 1, price: 200, cost: 125 }] })],
    { clientId: "client-1" },
  ).invoice;
  const next = removeInvoiceLineAndPruneCompletedVisitSources(imported, imported.lineItems[0].id);
  const sources = invoiceCompletedVisitSources(next);

  assert.equal(next.lineItems.length, 0);
  assert.equal(sources.hasSources, false);
  assert.deepEqual(sources.sourceVisitClientIds, []);
});

test("visit lines retain source provenance, service tax rules, and item taxability", () => {
  const lines = completedVisitLineItems(visit(), { clientId: "client-1" });

  assert.deepEqual(lines.map((line) => line.kind), ["service", "part", "product"]);
  assert.deepEqual(lines.map((line) => line.taxable), [false, true, false]);
  assert.ok(lines.every((line) => line.sourceStopId === "stop-101"));
  assert.ok(lines.every((line) => line.sourceCompletionReceiptId === "receipt-101"));
  assert.equal(lines.some((line) => line.desc === "Office supplied part"), false);
  assert.equal(lines.some((line) => line.desc === "Included product"), false);
  assert.equal(completedVisitBillableTotal(visit(), { clientId: "client-1" }), 411);
});

test("a visit already linked by its receipt or stop is not added again", () => {
  const first = appendCompletedVisitsToInvoice({ id: "invoice-1", lineItems: [] }, [visit()], { clientId: "client-1" });
  const second = appendCompletedVisitsToInvoice(first.invoice, [visit({ sid: "renamed-stop" })], { clientId: "client-1" });

  assert.equal(second.addedLineCount, 0);
  assert.deepEqual(second.skippedVisitKeys, ["receipt:receipt-101"]);
  assert.equal(invoiceContainsCompletedVisit(first.invoice, visit(), { clientId: "client-1" }), true);
});

test("other invoice linkage is visible so the picker can disable double billing", () => {
  const linkedInvoice = {
    id: "invoice-2",
    number: "2050",
    sourceStopIds: ["stop-101"],
    lineItems: [],
  };
  assert.deepEqual(completedVisitInvoiceLink(visit(), [linkedInvoice], {
    clientId: "client-1",
    currentInvoiceId: "invoice-1",
  }), {
    invoiceId: "invoice-2",
    invoiceNumber: "2050",
    current: false,
  });
});

test("legacy history without server IDs receives a deterministic local source ID", () => {
  const legacy = visit({ sid: "", completionReceiptId: "", date: "05/10/2024", notes: "Legacy entry" });
  const first = completedVisitSource(legacy, { clientId: "client-1" });
  const second = completedVisitSource({ ...legacy }, { clientId: "client-1" });

  assert.match(first.sourceStopId, /^history_/);
  assert.equal(first.sourceStopId, second.sourceStopId);
  assert.equal(first.key, second.key);
});

test("invoice editor exposes a searchable multi-visit picker instead of the eight-visit shortcut", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const pickerStart = app.indexOf("function InvoiceVisitPicker");
  const editorStart = app.indexOf("function InvoiceEditor", pickerStart);
  const pickerSource = app.slice(pickerStart, editorStart);
  const editorEnd = app.indexOf("function CatalogPickerSheet", editorStart);
  const editorSource = app.slice(editorStart, editorEnd);

  assert.match(pickerSource, /Search completed visits/);
  assert.match(pickerSource, /Select visible/);
  assert.match(pickerSource, /Add \$\{selectedRows\.length\} visit/);
  assert.match(pickerSource, /completedVisitInvoiceLink/);
  assert.match(editorSource, /appendCompletedVisitsToInvoice/);
  assert.match(editorSource, /sourceStopIds: result\.sourceStopIds/);
  assert.match(editorSource, /sourceCompletionReceiptIds: result\.sourceCompletionReceiptIds/);
  assert.match(editorSource, /disabled=\{clientLockedByImportedVisits\}/);
  assert.match(editorSource, /reserveVisitSourcesBeforeAccounting\(baseInv\)/);
  assert.match(editorSource, /reservedSources = invoiceCompletedVisitSources\(reservation\.reservedInvoice\)/);
  assert.ok(
    editorSource.indexOf("reserveVisitSourcesBeforeAccounting(baseInv)") < editorSource.indexOf("const qbPayload = buildQbPayload()"),
    "visit sources must be reserved before any QuickBooks payload/request path",
  );
  assert.match(pickerSource, /Possible legacy link to invoice/);
  assert.doesNotMatch(editorSource, /completedHistory\.slice\(0, 8\)/);
  assert.doesNotMatch(editorSource, /lineItems: items/);
});
