import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../App.jsx", import.meta.url), "utf8");

test("linked invoice pulls use the conflict-safe QuickBooks reconciler", () => {
  assert.match(source, /import\s+\{[\s\S]*?reconcileQuickBooksInvoice[\s\S]*?\}\s+from\s+"\.\/quickbooksInvoiceReconciliation"/);
  assert.match(source, /applyQuickBooksInvoiceSaveResult/);
  assert.match(source, /return reconcileQuickBooksInvoice\(iv,\s*qi\)/);
  assert.match(source, /qbBaseContentFingerprint:\s*qi\.qbContentFingerprint/);
  assert.match(source, /qbHasUnsupportedLines:\s*!!qi\.qbHasUnsupportedLines/);
  assert.doesNotMatch(source, /filter\(iv => iv\.source !== "quickbooks"\)/);
  assert.match(source, /preferredByQbId/);
  assert.match(source, /qbSyncStatus:\s*"duplicate-local-qb-id"/);
  assert.doesNotMatch(source, /const kept = prevList\.filter/);
});

test("authoritative linked snapshots use QuickBooks totals until the editor changes them", () => {
  assert.match(source, /if\s*\(inv\.qbAuthoritative === true && inv\.total != null/);
  assert.doesNotMatch(source, /inv\.source === "quickbooks"\s*\|\|/);
  assert.match(source, /locallyEdited:\s*true/);
  assert.match(source, /qbAuthoritative:\s*false/);
  assert.match(source, /qbSyncStatus:\s*"pending-push"/);
});

test("QuickBooks sync alone does not mark a draft sent and a successful client delivery does", () => {
  assert.doesNotMatch(source, /status:\s*inv\.status === "Draft"\s*\?\s*"Sent"/);
  assert.match(source, /onSent\(\{\s*\.\.\.invoice,\s*status:\s*"Sent",\s*sentDate:\s*todayMDY\(\)\s*\}\)/);
  assert.match(source, /if\s*\(deliveredToClient\)\s*onSave\(\{\s*\.\.\.invoice,\s*status:\s*"Sent"/);
  assert.doesNotMatch(source, /applyQuickBooksInvoiceSaveResult\(\{\s*\.\.\.inv,\s*status:\s*"Sent"\s*\}/);
});

test("entering a QuickBooks-only line cost makes that cost known", () => {
  assert.match(source, /const setLineCost = \(id, rawValue\)/);
  assert.match(source, /knownUnitCost:\s*costKnown\s*\?\s*value\s*:\s*""/);
  assert.match(source, /costKnown,/);
  assert.match(source, /onChange=\{e => setLineCost\(l\.id, e\.target\.value\)\}/);
});

test("a deleted QuickBooks invoice gets a distinct stable recreation request key", () => {
  assert.match(source, /qbCreateRequestKey:\s*`\$\{inv\.id\}:recreate:\$\{inv\.qbId\}`/);
});

test("late fees on linked invoices become pending QuickBooks edits", () => {
  assert.match(
    source,
    /lateFeeAppliedAt:\s*todayISO,[\s\S]*?\.\.\.\(inv\.qbId\s*\?\s*\{[\s\S]*?locallyEdited:\s*true,[\s\S]*?qbAuthoritative:\s*false,[\s\S]*?qbPendingLocalEdits:\s*true,[\s\S]*?qbSyncStatus:\s*"pending-push"/,
  );
});

test("QuickBooks refresh is throttled and resumes without reloading the app", () => {
  assert.doesNotMatch(source, /qb_auto_synced/);
  assert.match(source, /qb_autosync_at/);
  assert.match(source, /runQuickBooksRefresh/);
  assert.match(source, /inFlight/);
  assert.match(source, /window\.addEventListener\("focus", refreshWhenVisible\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(source, /App\.addListener\("appStateChange"/);
  assert.match(source, /5 \* 60 \* 1000/);
  assert.match(source, /localStorage\.setItem\("qb_autosync_at"[\s\S]*?return data/);
});

test("QuickBooks update payload carries the reconciliation and jurisdiction fields", () => {
  for (const field of [
    "qbBaseContentFingerprint",
    "qbTaxCodeRef",
    "qbLineId",
    "qbItemRef",
    "clientStreet",
    "clientCity",
    "clientState",
    "clientZip",
  ]) {
    assert.match(source, new RegExp(`${field}:`), `${field} should be sent or persisted`);
  }
});

test("invoice conflicts, failed links, and QuickBooks-only cost gaps are visible and reviewable", () => {
  assert.match(source, /invoiceReconciliationIssue/);
  assert.match(source, /editorReviewIssue\?\.title/);
  assert.match(source, /editorReviewIssue\?\.reason/);
  assert.match(source, /Use QuickBooks version/);
  assert.match(source, /Keep SPS version/);
  assert.match(source, /Added in QuickBooks · add its cost for accurate profit reporting/);
});

test("an interrupted QuickBooks create never overwrites newer SPS edits on retry", () => {
  assert.match(source, /quickBooksInvoiceIntentSignature/);
  assert.match(source, /qbCreateOutcomeUnknown:\s*true/);
  assert.match(source, /qbCreateIntentSignature:\s*originalCreateIntent\s*\|\|\s*currentCreateIntent/);
  assert.match(source, /originalCreateIntent\s*!==\s*currentCreateIntent/);
  assert.match(source, /reason:\s*"newer-local-edits-after-unknown-create"/);
  assert.match(source, /QuickBooks recovered the original invoice, but SPS has newer edits/);
});

test("outstanding summaries and client amount-due actions use remaining balance", () => {
  assert.match(source, /const outstandingTotal = outstandingInvoices\.reduce\(\(s, iv\) => s \+ invoiceTotals\(iv\)\.balance/);
  assert.match(source, /const totalOutstanding = all\.filter[\s\S]*?reduce\(\(s,iv\) => s \+ invoiceTotals\(iv\)\.balance/);
  assert.match(source, /_balance:\s*invoiceTotals\(iv\)\.balance/);
  assert.match(source, /const totalOwed = outstanding\.reduce\(\(s, iv\) => s \+ invoiceTotals\(iv\)\.balance/);
  assert.match(source, /Pay \$\$\{\(tot\.balance\|\|0\)\.toFixed\(2\)\} Now/);
  assert.match(source, />Amount Due<\/span>[\s\S]*?money\(totals\.balance\)/);
  assert.match(source, /qbAccounting\.openInvoiceCount/);
  assert.match(source, /qbAccounting\.openInvoiceBalance/);
  assert.match(source, /qbAccounting\.paymentsReceivedThisMonth/);
  assert.match(source, /available credits/);
});
