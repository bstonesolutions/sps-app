import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../App.jsx", import.meta.url), "utf8");

test("invoice progress save is an awaited SPS-only checkpoint", async () => {
  const app = await readApp();
  const start = app.indexOf("const saveProgress = async");
  const end = app.indexOf("const save = async", start);
  const progress = app.slice(start, end);

  assert.ok(start > 0 && end > start);
  assert.match(progress, /await onPersistProgress\(candidate/);
  assert.match(progress, /baselineJson: progressBaselineRef\.current/);
  assert.match(progress, /Saved in SPS · QuickBooks unchanged\./);
  assert.match(progress, /progressBaselineRef\.current = JSON\.stringify\(confirmed\)/);
  assert.match(progress, /editRevisionRef\.current === revisionAtStart/);
  assert.doesNotMatch(progress, /qbId|qbCreateOutcomeUnknown|qbSyncStatus:\s*"sps-only"/);
  assert.doesNotMatch(progress, /QB_API/);
  assert.doesNotMatch(progress, /fetch\(/);
  assert.doesNotMatch(progress, /finishSave\(/);
  assert.doesNotMatch(progress, /setSendStep\(/);
  assert.doesNotMatch(progress, /onSave\(/);
});

test("QuickBooks failures retain progress through the confirmed SPS checkpoint", async () => {
  const app = await readApp();
  const helperStart = app.indexOf("const persistRetainedEditorInvoice = async");
  const helperEnd = app.indexOf("const reserveVisitSourcesBeforeAccounting = async", helperStart);
  const helper = app.slice(helperStart, helperEnd);
  const saveStart = app.indexOf("const save = async");
  const saveEnd = app.indexOf("const field =", saveStart);
  const save = app.slice(saveStart, saveEnd);

  assert.ok(helperStart > 0 && helperEnd > helperStart);
  assert.match(helper, /await onPersistProgress\(candidateInvoice/);
  assert.match(helper, /baselineJson: progressBaselineRef\.current/);
  assert.match(helper, /String\(confirmed\.id \|\| ""\) !== String\(candidateInvoice\.id \|\| ""\)/);
  assert.match(helper, /progressBaselineRef\.current = JSON\.stringify\(confirmed\)/);
  assert.match(helper, /setIsPersisted\(true\)/);
  assert.match(helper, /editRevisionRef\.current === revisionAtSaveStart/);
  assert.doesNotMatch(helper, /onSave\(/);
  assert.doesNotMatch(helper, /finishSave\(/);

  assert.equal((save.match(/persistRetainedEditorInvoice\(/g) || []).length, 6);
  assert.doesNotMatch(save, /onSave\((pending|conflict|failedInvoice)\)/);
  assert.doesNotMatch(save, /Saved locally/);
  assert.match(save, /const rememberUnknownCreate = async/);
  assert.match(save, /const acceptCreateResult = async/);
  assert.equal((save.match(/await rememberUnknownCreate\(/g) || []).length, 3);
  assert.equal((save.match(/await acceptCreateResult\(/g) || []).length, 2);
});

test("completed-visit reservation advances the recovery baseline before QuickBooks", async () => {
  const app = await readApp();
  const saveStart = app.indexOf("const save = async");
  const saveEnd = app.indexOf("const field =", saveStart);
  const save = app.slice(saveStart, saveEnd);
  const reservationAt = save.indexOf("await reserveVisitSourcesBeforeAccounting(baseInv)");
  const baselineAt = save.indexOf("progressBaselineRef.current = JSON.stringify(reservation.reservedInvoice)");
  const accountingAt = save.indexOf("const res = await fetch(endpoint");

  assert.ok(reservationAt > 0);
  assert.ok(baselineAt > reservationAt);
  assert.ok(accountingAt > baselineAt);
  assert.match(save.slice(reservationAt, accountingAt), /setIsPersisted\(true\)/);
});

test("invoice editor presents a restrained SPS checkpoint before the QuickBooks action", async () => {
  const app = await readApp();
  const start = app.indexOf("data-invoice-save-actions");
  const end = app.indexOf("{!qbConnected &&", start);
  const actions = app.slice(start, end);

  assert.ok(start > 0 && end > start);
  assert.match(actions, /data-invoice-save-progress/);
  assert.match(actions, /Save progress keeps this invoice in SPS\. QuickBooks will not change\./);
  assert.match(actions, /Save.*Create.*sync to QuickBooks/s);
  assert.match(actions, /gridTemplateColumns: stackInvoiceSaveActions \? "1fr" : "minmax\(0, 2fr\) minmax\(0, 3fr\)"/);
  assert.match(actions, /role="group"/);
  assert.match(actions, /aria-label="Invoice save actions"/);
  assert.match(actions, /disabled=\{progressState === "saving" \|\| qbState === "sending"\}/);
  assert.match(actions, /disabled=\{qbState === "sending" \|\| progressState === "saving"\}/);
  assert.ok(actions.indexOf("Save progress") < actions.indexOf("sync to QuickBooks"));
  const progressButtonStart = actions.indexOf("<button");
  const progressButtonEnd = actions.indexOf("</button>", progressButtonStart);
  const progressButton = actions.slice(progressButtonStart, progressButtonEnd);
  assert.match(progressButton, /background: T\.surface/);
  assert.match(progressButton, /border: `1\.5px solid \$\{T\.border\}`/);
  assert.doesNotMatch(progressButton, /background: T\.primary/);
});

test("progress persistence validates visits and confirms the exact shared invoice", async () => {
  const app = await readApp();
  const start = app.indexOf("const handlePersistInvoiceProgress = async");
  const end = app.indexOf("const handlePersistInvoiceMutation = async", start);
  const persistence = app.slice(start, end);

  assert.ok(start > 0 && end > start);
  assert.match(persistence, /store\.flushKey\("sps_invoices"\)/);
  assert.match(persistence, /store\.refresh\("sps_invoices"\)/);
  assert.match(persistence, /JSON\.stringify\(latestInvoices\[index\]\) !== baselineJson/);
  assert.match(persistence, /reserveCompletedVisitInvoice\(/);
  assert.match(persistence, /store\.replaceMany/);
  assert.match(persistence, /expectedVersion: Number\(invoiceRead\.version\)/);
  assert.match(persistence, /const confirmedRead = await store\.get\("sps_invoices"\)/);
  assert.match(persistence, /JSON\.stringify\(confirmed\) !== JSON\.stringify\(nextInvoice\)/);
  assert.match(persistence, /setInvoices\(confirmedInvoices\)/);
  assert.ok(persistence.indexOf("!== baselineJson") < persistence.indexOf("reserveCompletedVisitInvoice("));
  assert.ok(persistence.indexOf("reserveCompletedVisitInvoice(") < persistence.indexOf("store.replaceMany"));
  assert.ok(persistence.indexOf("store.replaceMany") < persistence.indexOf("store.get(\"sps_invoices\")"));
  assert.doesNotMatch(persistence, /QB_API/);
  assert.doesNotMatch(persistence, /notifyOwnerEmail/);
  assert.doesNotMatch(persistence, /postClientMessage/);
  assert.doesNotMatch(persistence, /sendPushEvent/);
});

test("progress checkpoints cannot manufacture invoice delivery or payment lifecycle", async () => {
  const app = await readApp();
  const start = app.indexOf("// A checkpoint stores invoice content");
  const end = app.indexOf("const candidateNumber", start);
  const lifecycle = app.slice(start, end);
  const persistenceStart = app.indexOf("const handlePersistInvoiceProgress = async");
  const persistenceEnd = app.indexOf("const handlePersistInvoiceMutation = async", persistenceStart);
  const persistence = app.slice(persistenceStart, persistenceEnd);

  assert.ok(start > 0 && end > start);
  assert.match(lifecycle, /status: persistedInvoice\?\.status \|\| "Draft"/);
  ["sentAt", "deliveredAt", "qbEmailStatus", "viewedAt", "paymentLink", "paidAt", "payments", "paymentStatus"].forEach((field) => {
    assert.match(lifecycle, new RegExp(`"${field}"`));
  });
  assert.match(lifecycle, /progressCandidate\[fieldName\] = persistedInvoice\[fieldName\]/);
  assert.match(lifecycle, /delete progressCandidate\[fieldName\]/);
  assert.match(persistence, /reserveCompletedVisitInvoice\(\s*progressCandidate,/);
  assert.doesNotMatch(lifecycle, /status: candidateInvoice\.status/);
});

test("every invoice editor entry point receives the progress persistence callback", async () => {
  const app = await readApp();

  assert.match(app, /function InvoicesScreen\([\s\S]*?onPersistProgress/);
  assert.match(app, /function ClientInvoices\([\s\S]*?onPersistProgress/);
  assert.match(app, /function ClientDetail\([\s\S]*?onPersistInvoiceProgress/);
  assert.match(app, /function EstimatesScreen\([\s\S]*?onPersistInvoiceProgress/);
  const editorTags = app.match(/<InvoiceEditor\b[\s\S]*?\/>/g) || [];
  assert.ok(editorTags.length >= 5);
  editorTags.forEach((tag) => assert.match(tag, /onPersistProgress=/));
  assert.match(app, /onPersistProgress=\{onPersistInvoiceProgress\}/);
  assert.match(app, /onPersistInvoiceProgress=\{handlePersistInvoiceProgress\}/);
  assert.match(app, /onPersistProgress=\{handlePersistInvoiceProgress\}/);
});

test("reconciliation opens the canonical invoice so progress baselines exclude view fields", async () => {
  const app = await readApp();
  const start = app.indexOf("onReview={(invoice) =>");
  const end = app.indexOf("onViewRelated=", start);
  const review = app.slice(start, end);

  assert.ok(start > 0 && end > start);
  assert.match(review, /const canonicalInvoice = \(invoices \|\| \[\]\)\.find/);
  assert.match(review, /setEditing\(canonicalInvoice\)/);
  assert.doesNotMatch(review, /setEditing\(invoice\)/);
});
