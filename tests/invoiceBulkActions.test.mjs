import test from "node:test";
import assert from "node:assert/strict";

import {
  applyInvoiceBulkEdits,
  applySafeBulkInvoiceEdits,
  invoiceBulkEditEligibility,
  invoiceSelectionForVisible,
  pruneInvoiceSelection,
  sanitizeBulkInvoicePatch,
  summarizeSelectedInvoices,
} from "../invoiceBulkActions.js";

const invoices = [
  { id: "draft-1", number: "1", date: "2026-08-01", dueDate: "2026-08-16", status: "Draft", total: 100, lineItems: [{ desc: "A" }] },
  { id: "draft-2", number: "2", date: "08/02/2026", dueDate: "08/17/2026", status: "Draft", total: 200, taxRate: 6 },
  { id: "qb-3", qbId: "300", number: "3", date: "2026-08-03", status: "Sent", total: 300 },
  { id: "paid-4", number: "4", status: "Paid", total: 400 },
];

test("select all affects only the currently visible invoices", () => {
  assert.deepEqual(
    invoiceSelectionForVisible(["draft-1"], [invoices[1], invoices[2]], true),
    ["draft-1", "draft-2", "qb-3"],
  );
  assert.deepEqual(
    invoiceSelectionForVisible(["draft-1", "draft-2", "qb-3"], [invoices[1], invoices[2]], false),
    ["draft-1"],
  );
  assert.deepEqual(pruneInvoiceSelection(["draft-1", "qb-3"], [invoices[0]]), ["draft-1"]);
});

test("bulk editing changes only safe SPS drafts and protects QuickBooks and closed invoices", () => {
  const result = applyInvoiceBulkEdits(invoices, invoices.map((invoice) => invoice.id), {
    termsDays: 30,
    status: "Sent",
  });

  assert.equal(result.changed.length, 2);
  assert.deepEqual(result.skipped, [
    { id: "qb-3", reason: "quickbooks-managed" },
    { id: "paid-4", reason: "closed" },
  ]);
  assert.equal(result.invoices[0].dueDate, "8/31/2026");
  assert.equal(result.invoices[1].dueDate, "9/1/2026");
  assert.equal(result.invoices[0].termsDays, 30);
  assert.equal(result.invoices[0].status, "Sent");
  assert.deepEqual(result.invoices[0].lineItems, invoices[0].lineItems);
  assert.equal(result.invoices[1].taxRate, 6);
  assert.strictEqual(result.invoices[2], invoices[2]);
  assert.strictEqual(result.invoices[3], invoices[3]);
});

test("an exact due date applies without changing accounting fields", () => {
  const result = applyInvoiceBulkEdits(invoices, ["draft-1"], { dueDate: "2026-10-15" });
  assert.equal(result.changed[0].dueDate, "2026-10-15");
  assert.equal(result.changed[0].number, "1");
  assert.equal(result.changed[0].total, 100);
  assert.deepEqual(result.changed[0].lineItems, [{ desc: "A" }]);
});

test("eligibility is explicit and fail closed", () => {
  assert.deepEqual(invoiceBulkEditEligibility({}), { eligible: false, reason: "missing-id" });
  assert.deepEqual(invoiceBulkEditEligibility(invoices[2]), { eligible: false, reason: "quickbooks-managed" });
  assert.deepEqual(invoiceBulkEditEligibility(invoices[0]), { eligible: true, reason: "" });
});

test("selection summary counts only selected invoices in the current filtered set", () => {
  const filtered = [
    { id: "a", _total: 10.01 },
    { id: "b", _total: 20.02 },
  ];
  assert.deepEqual(summarizeSelectedInvoices(filtered, ["a", "outside"]), {
    ids: ["a"], count: 1, total: 10.01,
  });
});

test("bulk patch drops accounting fields and keeps editable terms", () => {
  assert.deepEqual(sanitizeBulkInvoicePatch({
    clientId: "hijack",
    lineItems: [{ desc: "no" }],
    taxRate: 99,
    termsDays: 15,
    terms: "Updated terms",
  }), { termsDays: 15, notes: "Updated terms" });

  const result = applySafeBulkInvoiceEdits([
    { id: "a", date: "8/19/2026", status: "Draft", notes: "Old" },
  ], ["a"], { termsDays: 15, notes: "New" });
  assert.equal(result.invoices[0].dueDate, "9/3/2026");
  assert.equal(result.invoices[0].termsDays, 15);
  assert.equal(result.invoices[0].notes, "New");
});

test("unresolved QuickBooks records fail closed while intentional SPS-only records remain editable", () => {
  assert.equal(invoiceBulkEditEligibility({ id: "qb", qbNeedsReview: true }).eligible, false);
  assert.equal(invoiceBulkEditEligibility({ id: "qb2", qbSyncStatus: "pending" }).eligible, false);
  assert.equal(invoiceBulkEditEligibility({ id: "local", qbSyncStatus: "sps-only", status: "Draft" }).eligible, true);
});

test("an invalid or empty patch changes nothing", () => {
  const original = [{ id: "a", status: "Draft" }];
  const result = applySafeBulkInvoiceEdits(original, ["a"], { clientId: "no", termsDays: -1 });
  assert.equal(result.updatedIds.length, 0);
  assert.strictEqual(result.invoices[0], original[0]);
});
