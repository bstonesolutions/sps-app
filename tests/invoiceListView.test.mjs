import assert from "node:assert/strict";
import test from "node:test";

import {
  invoiceDescription,
  invoiceListDate,
  invoiceMatchesSearch,
  sortInvoiceList,
} from "../invoiceListView.js";

const ids = (rows) => rows.map((row) => row.id);

test("description uses actual invoice title and all canonical line contents", () => {
  const invoice = {
    title: "Fall service", description: " October work ",
    lineItems: [{ desc: " Pond maintenance\nOctober " }, { description: "Pump repair" }, { desc: "pond maintenance October" }],
  };
  assert.equal(invoiceDescription(invoice), "Fall service · October work · Pond maintenance October · Pump repair");
});

test("bundle contents remain searchable without duplicating existing line wording", () => {
  assert.equal(invoiceDescription({ lineItems: [{ desc: "Winter service", bundleNote: "Cover and filter" }] }), "Winter service (Cover and filter)");
  assert.equal(invoiceDescription({ lineItems: [{ desc: "Winter service (Cover and filter)", bundleNote: "cover and filter" }] }), "Winter service (Cover and filter)");
  assert.equal(invoiceDescription({ lineItems: [{ bundleNote: "Cover and filter" }] }), "Cover and filter");
});

test("legacy and QuickBooks shapes use real descriptions and ignore calculated accounting rows", () => {
  assert.equal(invoiceDescription({ lines: [{ description: "Leaf cleanup" }] }), "Leaf cleanup");
  assert.equal(invoiceDescription({ items: [{ name: "Pool inspection" }] }), "Pool inspection");
  assert.equal(invoiceDescription({ Line: [
    { DetailType: "SalesItemLineDetail", Description: "Pond repair" },
    { DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { name: "Replacement pump" } } },
    { DetailType: "SubTotalLineDetail", Description: "Subtotal" },
    { DetailType: "DiscountLineDetail", Description: "Discount" },
  ] }), "Pond repair · Replacement pump");
});

test("canonical empty or changed lines cannot resurrect a stale imported line snapshot", () => {
  assert.equal(invoiceDescription({ lineItems: [], lines: [{ description: "Old charge" }] }), "");
  assert.equal(invoiceDescription({ lineItems: [{ desc: "New charge" }], lines: [{ description: "Old charge" }] }), "New charge");
  assert.equal(invoiceDescription({ notes: "Thank you for your business", privateNote: "Internal detail" }), "");
  assert.equal(invoiceDescription({ lineItems: [null, {}, { desc: false }, { desc: { anything: "unexpected" } }] }), "");
});

test("search finds later line contents, bundles, title, invoice number and canonical client", () => {
  const invoice = {
    number: "INV-142", _client: { name: "José Rivera" }, clientName: "Old client name",
    title: "October visit", lineItems: [{ desc: "Pond maintenance" }, { desc: "Pump repair", bundleNote: "Impeller replacement" }],
    notes: "Thank you", privateNote: "Secret internal comment",
  };
  for (const query of ["INV-142", "jose", "October", "pump repair", "impeller", "rivera replacement", "   "]) {
    assert.equal(invoiceMatchesSearch(invoice, query), true, query);
  }
  for (const query of ["Old client name", "Thank you", "Secret", "leaf"]) assert.equal(invoiceMatchesSearch(invoice, query), false, query);
});

test("date parsing supports local SPS and ISO calendar dates without timezone shifts", () => {
  for (const input of ["04/09/2026", "4/9/2026", "2026-04-09", "2026-04-09T00:00:00.000Z"]) {
    const result = invoiceListDate(input);
    assert.equal(result.getFullYear(), 2026);
    assert.equal(result.getMonth(), 3);
    assert.equal(result.getDate(), 9);
  }
  for (const input of ["", "not a date", "02/30/2026", "2026-02-29", "2026-13-01", "2026-04-09Tnonsense", new Date(NaN)]) assert.equal(invoiceListDate(input), null);
  assert.equal(invoiceListDate("2024-02-29").getDate(), 29);
});

test("description sorts both ways and puts missing descriptions last", () => {
  const rows = [{ id: "empty" }, { id: "pond", lineItems: [{ desc: "Pond work" }] }, { id: "leaf", title: "Leaf work" }];
  assert.deepEqual(ids(sortInvoiceList(rows, "description_asc")), ["leaf", "pond", "empty"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "description_desc")), ["pond", "leaf", "empty"]);
});

test("invoice number sorting respects numeric sequences and includes prefixes", () => {
  const rows = [{ id: "10", number: "INV-10" }, { id: "2", number: "INV-2" }, { id: "unknown" }, { id: "qb", DocNumber: "INV-9" }];
  assert.deepEqual(ids(sortInvoiceList(rows, "number_asc")), ["2", "qb", "10", "unknown"]);
  assert.deepEqual(ids(sortInvoiceList(rows)), ["10", "qb", "2", "unknown"]);
});

test("issued and due date sorting use the appropriate field across formats", () => {
  const rows = [
    { id: "first", date: "04/01/2026", dueDate: "05/10/2026" },
    { id: "second", date: "2026-04-20", dueDate: "2026-04-25" },
    { id: "invalid", date: "2026-02-30", dueDate: "bad", _date: new Date(2026, 0, 1) },
  ];
  assert.deepEqual(ids(sortInvoiceList(rows, "date_asc")), ["first", "second", "invalid"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "date_desc")), ["second", "first", "invalid"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "due_asc")), ["second", "first", "invalid"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "due_desc")), ["first", "second", "invalid"]);
});

test("enriched values sort client, amount, issued date and effective status", () => {
  const rows = [
    { id: "b", _client: { name: "Beta" }, clientName: "Zulu", _total: 0, total: 300, _date: new Date(2026, 5, 2), _status: "Sent", status: "Draft" },
    { id: "a", clientName: "Alpha", _total: 200, _date: new Date(2026, 5, 1), _status: "Paid" },
    { id: "unknown", _total: NaN },
  ];
  assert.deepEqual(ids(sortInvoiceList(rows, "client_asc")), ["a", "b", "unknown"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "client_desc")), ["b", "a", "unknown"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "amount_asc")), ["b", "a", "unknown"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "amount_desc")), ["a", "b", "unknown"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "date_asc")), ["a", "b", "unknown"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "status_asc")), ["a", "b", "unknown"]);
  assert.deepEqual(ids(sortInvoiceList(rows, "status_desc")), ["b", "a", "unknown"]);
});

test("sorting preserves invoice objects, input order and selected row membership", () => {
  const rows = [{ id: "b", number: "INV-2", status: "Draft" }, { id: "a", number: "INV-1", status: "Paid" }];
  const original = structuredClone(rows);
  const sorted = sortInvoiceList(rows, "number_asc");
  assert.deepEqual(rows, original);
  assert.notEqual(sorted, rows);
  assert.equal(sorted[0], rows[1]);
  assert.equal(sorted[1], rows[0]);
  assert.deepEqual(sortInvoiceList(null), []);
});

test("ties use invoice number then stable invoice ID", () => {
  const rows = [{ id: "10", number: "INV-10", _total: 50 }, { id: "b", number: "INV-2", _total: 50 }, { id: "a", number: "INV-2", _total: 50 }];
  assert.deepEqual(ids(sortInvoiceList(rows, "amount_desc")), ["a", "b", "10"]);
});
