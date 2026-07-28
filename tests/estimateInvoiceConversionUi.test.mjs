import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("estimate editor exposes a confirmed local draft conversion and reopens the linked invoice", () => {
  assert.match(app, /data-estimate-invoice-conversion/);
  assert.match(app, /Create draft invoice/);
  assert.match(app, /Open invoice \$\{linkedInvoice\.number/);
  assert.match(app, /onConvertEstimate=\{handleConvertEstimateToInvoice\}/);
  assert.match(app, /findInvoiceForEstimate\(list, estimate\)/);
  assert.match(app, /estimateToDraftInvoice\(/);
  assert.match(app, /setInvoiceEditor\(saved\)/);
});

test("conversion is permission-gated, rejects declined estimates, and does not invoke QuickBooks", () => {
  const start = app.indexOf("const handleConvertEstimateToInvoice");
  const end = app.indexOf("const handleDeleteInvoice", start);
  assert.ok(start > 0 && end > start);
  const conversion = app.slice(start, end);

  assert.match(app, /const canCreateInvoice = canManage && !!\(perms\.isAdmin \|\| perms\.invoiceCreate\)/);
  assert.match(conversion, /declined estimate cannot be converted/i);
  assert.match(conversion, /await store\.flush\(\)/);
  assert.match(conversion, /await store\.refresh\("sps_invoices"\)/);
  assert.match(conversion, /await store\.replaceMany\(/);
  assert.match(conversion, /expectedVersion: Number\(refreshed\.version\) \|\| 0/);
  assert.doesNotMatch(conversion, /QB_API|quickbooks|syncToQuickBooks/i);
});

test("completing an estimate requires an intentional same-client invoice link", () => {
  assert.match(app, /data-estimate-completion/);
  assert.match(app, /Close estimate/);
  assert.match(app, /Link invoice & mark complete/);
  assert.match(app, /id="estimate-completion-invoice"/);
  assert.match(app, /Only saved, non-void invoices for this client are available/);
  assert.match(app, /ESTIMATE_STATUSES\.filter\(\(\{ id \}\) => id !== "complete"\)/);
  assert.match(app, /onCompleteEstimate=\{handleCompleteEstimate\}/);
  assert.match(app, /onCompleteEstimate\(form\.id, completionInvoiceId, form\.linkedInvoiceId \|\| ""\)/);
});

test("estimate completion is server-confirmed and never invokes invoice or QuickBooks writes", () => {
  const start = app.indexOf("const handleCompleteEstimate");
  const end = app.indexOf("const handleDeleteInvoice", start);
  assert.ok(start > 0 && end > start);
  const completion = app.slice(start, end);

  assert.match(completion, /await store\.flush\(\)/);
  assert.match(completion, /store\.refresh\("sps_estimates"\)/);
  assert.match(completion, /store\.refresh\("sps_invoices"\)/);
  assert.match(completion, /completeEstimateWithInvoice\(current, selectedInvoice/);
  assert.match(completion, /current\.linkedInvoiceId \|\| ""\) !== expectedInvoiceId/);
  assert.match(completion, /key: "sps_estimates"/);
  assert.match(completion, /expectedVersion: Number\(estimateRead\.version\) \|\| 0/);
  assert.match(completion, /confirmed\.status !== "complete"/);
  assert.match(completion, /confirmed\.linkedInvoiceId/);
  assert.doesNotMatch(completion, /QB_API|quickbooks|syncToQuickBooks|handleSaveInvoice|setInvoices/i);
});

test("scheduling approved work atomically creates or reuses its one draft invoice", () => {
  const start = app.indexOf("const handleScheduleApprovedEstimate");
  const end = app.indexOf("const handleResetData", start);
  assert.ok(start > 0 && end > start);
  const scheduling = app.slice(start, end);

  assert.match(scheduling, /estimateTaxMigrationImpact\(current, invoicing\?\.taxRate\)/);
  assert.match(scheduling, /options\.taxMigrationConfirmed !== true/);
  assert.match(scheduling, /taxMigrationConfirmedAt/);
  assert.match(scheduling, /findInvoiceForEstimate\(latestInvoices, billingEstimate\)/);
  assert.match(scheduling, /estimateToDraftInvoice\(billingEstimate/);
  assert.match(scheduling, /key: "sps_estimates"/);
  assert.match(scheduling, /key: "sps_schedule"/);
  assert.match(scheduling, /key: "sps_invoices"/);
  assert.match(scheduling, /expectedVersion: Number\(invoiceRead\.version\) \|\| 0/);
});

test("legacy service-tax totals require explicit owner confirmation before conversion or scheduling", () => {
  assert.match(app, /estimateTaxMigrationImpact\(linkedEstimate\)/);
  assert.match(app, /Current invoice rules make services non-taxable/);
  assert.match(app, /taxMigrationConfirmed: taxMigration\.requiresConfirmation/);
  assert.match(app, /Review and confirm the corrected service-tax total before creating this invoice/);
});

test("estimate-linked schedule and billing records cannot be orphaned by delete actions", () => {
  const scheduleStart = app.indexOf("const deleteSelected = () =>");
  const scheduleEnd = app.indexOf("const reassignSelectedTo", scheduleStart);
  const estimateStart = app.indexOf("const deleteEstimate = (id) =>");
  const estimateEnd = app.indexOf("const linkedInvoiceForEstimate", estimateStart);
  assert.ok(scheduleStart > 0 && scheduleEnd > scheduleStart);
  assert.ok(estimateStart > 0 && estimateEnd > estimateStart);

  assert.match(app.slice(scheduleStart, scheduleEnd), /selectedStops\.some\(s => s\?\.sourceEstimateId\)/);
  assert.match(app.slice(estimateStart, estimateEnd), /findInvoiceForEstimate\(invoices, target\)/);
  assert.match(app.slice(estimateStart, estimateEnd), /target\.linkedScheduledStopId \|\| target\.linkedInvoiceId \|\| linkedInvoice/);
});

test("invoice deletion fresh-checks links and fences invoices, estimates, and schedule atomically", () => {
  const start = app.indexOf("const handleDeleteInvoice = async");
  const end = app.indexOf("const validateArrivalStop", start);
  assert.ok(start > 0 && end > start);
  const deletion = app.slice(start, end);

  assert.match(deletion, /store\.refresh\("sps_invoices"\)/);
  assert.match(deletion, /store\.refresh\("sps_estimates"\)/);
  assert.match(deletion, /store\.refresh\("sps_schedule"\)/);
  assert.match(deletion, /findInvoiceDeletionReferences\(target, latestEstimates, latestSchedule\)/);
  assert.match(deletion, /store\.replaceMany\(\[/);
  assert.match(deletion, /key: "sps_invoices"/);
  assert.match(deletion, /key: "sps_estimates"/);
  assert.match(deletion, /key: "sps_schedule"/);
  assert.match(deletion, /const confirmedRead = await store\.get\("sps_invoices"\)/);
  assert.ok(
    deletion.indexOf('store.replaceMany([') < deletion.indexOf('fetch(`${QB_API}/delete-invoice`'),
    "QuickBooks must only be changed after the atomic local deletion succeeds",
  );
});
