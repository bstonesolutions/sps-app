import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../App.jsx", import.meta.url), "utf8");
const readWorkspace = () => readFile(new URL("../MaintenanceCoverageWorkspace.jsx", import.meta.url), "utf8");

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
