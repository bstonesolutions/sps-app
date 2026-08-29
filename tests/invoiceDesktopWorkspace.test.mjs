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
  assert.match(screen, /Sync \$\{selectedQuickBooksPlan\.ready\.length\} draft/);
  assert.match(screen, /Send to clients/);
  assert.match(screen, /Edit selected/);
  assert.match(screen, /Create multiple/);
  assert.match(screen, /Refresh from QuickBooks/);
  assert.match(screen, /<InvoicesTable[\s\S]*selectedIds=\{selectedIds\}[\s\S]*onToggleAll=\{toggleAllVisibleInvoices\}/);
  assert.match(screen, /<InvoiceBulkEditModal/);
  assert.match(screen, /<InvoiceBulkSendModal/);
  assert.match(screen, /<InvoiceQuickBooksDraftSyncModal/);
  assert.doesNotMatch(screen, />Split</);
  assert.doesNotMatch(screen, />Table</);
  assert.doesNotMatch(screen, /width:\s*440/);
});

test("QuickBooks draft queue saves each invoice independently and never delivers to clients", async () => {
  const app = await readApp();
  const start = app.indexOf("function InvoiceQuickBooksDraftSyncModal");
  const end = app.indexOf("function BatchInvoiceModal", start);
  const modal = app.slice(start, end);

  assert.match(modal, /for \(const row of targets\)/);
  assert.match(modal, /create-invoice/);
  assert.match(modal, /applyQuickBooksInvoiceSaveResult/);
  assert.match(modal, /onPersistInvoice/);
  assert.match(modal, /data\.success !== true/);
  assert.match(modal, /!String\(data\.qbId/);
  assert.match(modal, /response\.status === 401/);
  assert.match(modal, /status: current\.status \|\| "Draft"/);
  assert.match(modal, /typeof onPersistInvoice !== "function"/);
  assert.doesNotMatch(modal, /onSave/);
  assert.match(modal, /no client message is sent/);
  assert.doesNotMatch(modal, /deliverSelectedInvoices/);
  assert.doesNotMatch(modal, /status: "Sent"/);
});

test("invoice deletion closes only a safe local draft number gap", async () => {
  const app = await readApp();
  const start = app.indexOf("const handleDeleteInvoice = async");
  const end = app.indexOf("const validateArrivalStop", start);
  const deletion = app.slice(start, end);

  assert.match(deletion, /deleteInvoiceAndCompactSafeDrafts\(latestInvoices, targetId, \{ protectedInvoiceIds \}\)/);
  assert.match(deletion, /renumbered: deletionPlan\.renumbered/);
});

test("QuickBooks batch results are persisted with a server-confirmed invoice mutation", async () => {
  const app = await readApp();
  const start = app.indexOf("const handlePersistInvoiceMutation = async");
  const end = app.indexOf("const handleSaveInvoice", start);
  const persistence = app.slice(start, end);

  assert.match(persistence, /store\.flushKey\("sps_invoices"\)/);
  assert.match(persistence, /store\.refresh\("sps_invoices"\)/);
  assert.match(persistence, /store\.replaceMany/);
  assert.match(persistence, /expectedVersion: Number\(invoiceRead\.version\)/);
  assert.match(persistence, /SPS could not verify the saved QuickBooks link/);
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
