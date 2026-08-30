import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../App.jsx", import.meta.url), "utf8");
const readWorkspace = () => readFile(new URL("../MaintenanceCoverageWorkspace.jsx", import.meta.url), "utf8");
const readLedger = () => readFile(new URL("../maintenancePaymentLedger.js", import.meta.url), "utf8");

test("maintenance coverage loads once per workspace visit and can be retried explicitly", async () => {
  const app = await readApp();
  const start = app.indexOf("function InvoicesScreen");
  const end = app.indexOf("function InvoiceDetail", start);
  const screen = app.slice(start, end);

  assert.match(screen, /maintenanceLedgerAttemptedRef = useRef\(false\)/);
  assert.match(screen, /maintenanceLedgerAttemptedRef\.current = true/);
  assert.match(screen, /if \(invoiceWorkspace !== "maintenance"\) maintenanceLedgerAttemptedRef\.current = false/);
  assert.doesNotMatch(screen, /maintenanceLedger \|\| maintenanceLedgerLoading\) return/);
});

test("maintenance payment workspace provides a monthly matrix and explicit invoice evidence", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace, /Payment calendar/);
  assert.match(workspace, /Future months stay visible without counting as missing/);
  assert.match(workspace, /data-maintenance-invoice-evidence/);
  assert.match(workspace, /Months covered by this choice/);
  assert.match(workspace, /QuickBooks confirmed/);
  assert.doesNotMatch(workspace, /<select value=\{invoiceId\}/);
});

test("maintenance history reconciliation waits for fresh QuickBooks state and exposes truthful evidence", async () => {
  const app = await readApp();
  const workspace = await readWorkspace();
  const start = app.indexOf("function InvoicesScreen");
  const end = app.indexOf("function InvoiceDetail", start);
  const screen = app.slice(start, end);

  assert.match(app, /const maintenanceQuickBooksSnapshotIssue = \(data\) =>/);
  assert.match(screen, /await Promise\.resolve\(onSyncData\(data\.invoices, data\.customers, data\)\)/);
  assert.match(screen, /canonicalPersistence\?\.ok/);
  assert.match(app, /pagination\.invoices/);
  assert.match(app, /pagination\.customers/);
  assert.match(app, /page\?\.complete !== true/);
  assert.match(screen, /const snapshotIssue = maintenanceQuickBooksSnapshotIssue\(freshQuickBooks\)/);
  assert.match(screen, /Connect QuickBooks before reconciling maintenance history/);
  assert.doesNotMatch(screen, /waitForMaintenanceQuickBooksCommit/);
  assert.doesNotMatch(screen, /store\.flushKey\(key\)/);
  assert.match(screen, /body: JSON\.stringify\(\{ action: "reconcile", fromYear, toYear \}\)/);
  assert.match(screen, /reconciliationReceipt=\{maintenanceReconciliationReceipt\}/);
  assert.match(screen, /maintenanceReconciliationStorageKey\(/);
  assert.match(screen, /sessionStorage\.setItem\(receiptStorageKey, JSON\.stringify\(reconciliationEvidence\)\)/);
  assert.match(screen, /updatedAt: data\.reconciliationReceipt\.updatedAt \|\| new Date\(\)\.toISOString\(\)/);
  assert.match(workspace, /currentYear - 24/);
  assert.match(workspace, /Reconcile history/);
  assert.match(workspace, /data-maintenance-reconciliation-receipt/);
  assert.match(workspace, /No matching payment/);
  assert.match(workspace, /Plan history needed/);
  assert.match(workspace, /Unallocated history/);
  assert.doesNotMatch(workspace, /No coverage/);
});

test("maintenance mobile filters open a matching month and the visible range is explicit", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace, /const statusMatchesView = \(status, view\)/);
  assert.match(workspace, /statusEntries\.find\(\(\{ status \}\) => statusMatchesView\(status, view\)\)/);
  assert.match(workspace, /openCell\(row, `\$\{year\}-\$\{preferredEntry\.number\}`\)/);
  assert.match(workspace, /Showing \{visibleRangeLabel\} \{year\}\. Counts below represent client months\./);
  assert.match(workspace, /const visibleRangeLabel = fullYear \? "January to December" : "April to December"/);
});

test("reconciliation receipt is touch-actionable, scoped, timestamped, and callback-safe", async () => {
  const app = await readApp();
  const workspace = await readWorkspace();
  const start = app.indexOf("function InvoicesScreen");
  const end = app.indexOf("function InvoiceDetail", start);
  const screen = app.slice(start, end);

  assert.match(workspace, /data-maintenance-reconciliation-details-toggle/);
  assert.match(workspace, /data-maintenance-reconciliation-details/);
  assert.match(workspace, /Show invoice, client, and reason/);
  assert.match(workspace, /Client not matched/);
  assert.match(workspace, /formatReceiptTimestamp\(receiptEvidence\.updatedAt\)/);
  assert.match(screen, /const syncQuickBooks = useCallback\(async \(\) =>/);
  assert.match(screen, /\}, \[canReviewAccounting, onSyncData\]\);/);
  assert.match(screen, /\}, \[loadMaintenanceLedger, syncQuickBooks\]\);/);
  assert.doesNotMatch(screen, /\}, \[loadMaintenanceLedger\]\); \/\/ eslint-disable-line react-hooks\/exhaustive-deps/);
  assert.match(screen, /qbAccounting\?\.realmId \|\| branding\?\.companyName/);
  assert.match(screen, /currentUserId/);
});

test("maintenance workspaces flatten canonical day rows and legacy stop client ids", async () => {
  const ledger = await readLedger();

  assert.match(ledger, /export function flattenMaintenanceSchedule\(schedule = \[\]\)/);
  assert.match(ledger, /for \(const stop of flattenMaintenanceSchedule\(schedule\)\)/);
  assert.match(ledger, /clientById\.has\(legacyClientId\)/);
  assert.match(ledger, /stop\?\.sid/);
});

test("maintenance controls are tablet safe and changing the visible year rebases selection", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace, /const compactControls = !!\(vp\.isPhone \|\| vp\.isTablet\)/);
  assert.match(workspace, /gridTemplateColumns: compactControls \? "1fr 1fr"/);
  assert.match(workspace, /const changeYear = \(nextYear\) => \{\s*setSelection\(null\);\s*setYear\(nextYear\);/);
  assert.match(workspace, /const toggleYearRange = \(\) => \{\s*setSelection\(null\);/);
  assert.match(workspace, /!initialMonth\.startsWith\(`\$\{year\}-`\)/);
});
