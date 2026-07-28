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
  assert.match(app, /estimateToDraftInvoice\(estimate/);
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
