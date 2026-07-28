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
