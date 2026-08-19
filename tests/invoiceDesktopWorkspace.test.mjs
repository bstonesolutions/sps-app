import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../App.jsx", import.meta.url), "utf8");

test("desktop invoice table supports selecting one or all filtered invoices", async () => {
  const app = await readApp();
  const start = app.indexOf("function InvoicesTable");
  const end = app.indexOf("function InvoiceBulkEditModal", start);
  const table = app.slice(start, end);

  assert.match(table, /selectedIds = \[\]/);
  assert.match(table, /Select all filtered invoices/);
  assert.match(table, /Select invoice \$\{iv\.number \|\| ""\}/);
  assert.match(table, /onToggleAll\?\.\(event\.target\.checked\)/);
  assert.match(table, /onToggleSelected\?\.\(iv\)/);
  assert.match(table, /event\.stopPropagation\(\)/);
});

test("desktop invoices use a full-width workspace and an explicit selection action bar", async () => {
  const app = await readApp();
  const start = app.indexOf("function InvoicesScreen");
  const end = app.indexOf("function InvoiceDetail", start);
  const screen = app.slice(start, end);

  assert.match(screen, /data-invoice-summary-rail/);
  assert.match(screen, /data-invoice-selection-bar/);
  assert.match(screen, /Send selected/);
  assert.match(screen, /Edit selected/);
  assert.match(screen, /Create batch/);
  assert.match(screen, /<InvoicesTable[\s\S]*selectedIds=\{selectedIds\}[\s\S]*onToggleAll=\{toggleAllVisibleInvoices\}/);
  assert.match(screen, /<InvoiceBulkEditModal/);
  assert.match(screen, /<InvoiceBulkSendModal/);
  assert.doesNotMatch(screen, />Split</);
  assert.doesNotMatch(screen, />Table</);
  assert.doesNotMatch(screen, /width:\s*440/);
});

test("bulk edits explain and enforce the QuickBooks safety boundary", async () => {
  const app = await readApp();
  const start = app.indexOf("function InvoiceBulkEditModal");
  const end = app.indexOf("function InvoiceBulkSendModal", start);
  const modal = app.slice(start, end);

  assert.match(modal, /Only SPS-owned invoices are changed here/);
  assert.match(modal, /QuickBooks-linked, paid, void, and unresolved records stay untouched/);
  assert.match(modal, /applySafeBulkInvoiceEdits/);
});
