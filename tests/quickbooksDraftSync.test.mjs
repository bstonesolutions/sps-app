import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuickBooksInvoicePayload,
  partitionQuickBooksDraftSelection,
  quickBooksDraftSyncEligibility,
} from "../quickbooksDraftSync.js";

const client = { id: "c1", name: "Sample Client", email: "client@example.com", phone: "555-0100" };

test("QuickBooks draft selection explicitly separates ready and protected records", () => {
  const invoices = [
    { id: "ready", number: "INV-1001", status: "Draft", clientId: "c1", lineItems: [{ desc: "Service", qty: 1, unitPrice: 100 }] },
    { id: "linked", number: "INV-1002", status: "Draft", clientId: "c1", qbId: "99", lineItems: [{ desc: "Service" }] },
    { id: "empty", number: "INV-1003", status: "Draft", clientId: "c1", lineItems: [] },
    { id: "sent", number: "INV-1004", status: "Sent", clientId: "c1", lineItems: [{ desc: "Service" }] },
  ];
  const result = partitionQuickBooksDraftSelection(invoices, () => client);
  assert.deepEqual(result.ready.map((row) => row.invoice.id), ["ready"]);
  assert.deepEqual(result.skipped.map((row) => row.reason), ["Already linked to QuickBooks", "No line items", "Not a draft"]);
});

test("unknown creates and SPS-only drafts fail closed", () => {
  assert.equal(quickBooksDraftSyncEligibility({ id: "a", status: "Draft", lineItems: [{}], qbCreateOutcomeUnknown: true }, client).eligible, false);
  assert.equal(quickBooksDraftSyncEligibility({ id: "a", status: "Draft", lineItems: [{}], qbSyncStatus: "sps-only" }, client).eligible, false);
});

test("an SPS progress checkpoint remains ready for a later deliberate QuickBooks sync", () => {
  const checkpoint = {
    id: "checkpoint-1",
    number: "INV-1005",
    status: "Draft",
    clientId: client.id,
    clientName: client.name,
    serviceMonth: "2026-09",
    lineItems: [{ desc: "Monthly service", qty: 1, unitPrice: 175 }],
  };

  assert.equal(quickBooksDraftSyncEligibility(checkpoint, client).eligible, true);
  const partitioned = partitionQuickBooksDraftSelection([checkpoint], () => client);
  assert.deepEqual(partitioned.ready.map((row) => row.invoice.id), ["checkpoint-1"]);
  assert.equal(partitioned.skipped.length, 0);
});

test("maintenance drafts need a service month before direct or bulk QuickBooks sync", () => {
  const draft = {
    id: "month-missing", number: "INV-1006", status: "Draft", date: "10/01/2026",
    lineItems: [{ desc: "Monthly service", qty: 1, unitPrice: 175 }],
  };
  assert.equal(quickBooksDraftSyncEligibility(draft, client).code, "maintenance-service-month-missing");
  assert.equal(partitionQuickBooksDraftSelection([draft], () => client).ready.length, 0);
  assert.equal(quickBooksDraftSyncEligibility({ ...draft, serviceMonth: "2026-09" }, client).eligible, true);
});

test("QuickBooks payload describes performed months and keeps canonical line service metadata", () => {
  const invoice = {
    id: "iv-month", number: "INV-1007", date: "10/01/2026", serviceMonth: "2026-10",
    lineItems: [
      { desc: "Monthly pond maintenance", serviceMonth: "2026-09", serviceDate: "2026-09-17", sourceVisitDates: ["2026-09-03", "2026-09-17"], qty: 1, unitPrice: 175, kind: "service" },
      { description: "Pump repair", qty: 1, unitPrice: 90, kind: "service" },
    ],
  };
  const payload = buildQuickBooksInvoicePayload(invoice, client, {});
  assert.equal(payload.date, "2026-10-01");
  assert.equal(payload.lineItems[0].description, "Monthly pond maintenance - September 2026");
  assert.equal(payload.lineItems[0].serviceMonth, "2026-09");
  assert.equal(payload.lineItems[0].serviceDate, "2026-09-17");
  assert.deepEqual(payload.lineItems[0].sourceVisitDates, ["2026-09-03", "2026-09-17"]);
  assert.equal(payload.lineItems[1].description, "Pump repair");
});

test("payload formatting remains nonthrowing for legacy records with missing service months", () => {
  const payload = buildQuickBooksInvoicePayload({ lineItems: [{ desc: "Monthly Service", qty: 1, unitPrice: 175 }] }, client, {});
  assert.equal(payload.lineItems[0].description, "Monthly Service");
});

test("missing numbers and zero-value lines never enter the QuickBooks draft queue", () => {
  assert.equal(quickBooksDraftSyncEligibility({ id: "a", status: "Draft", lineItems: [{ desc: "Service", qty: 1, unitPrice: 100 }] }, client).reason, "Invoice number is missing");
  assert.equal(quickBooksDraftSyncEligibility({ id: "a", number: "INV-1", status: "Draft", lineItems: [{ desc: "Service", qty: 1, unitPrice: 0 }] }, client).reason, "No billable line items");
  assert.equal(quickBooksDraftSyncEligibility({ id: "a", number: "INV-1", status: "Draft", lineItems: [{ desc: "", qty: 1, unitPrice: 100 }] }, client).reason, "No billable line items");
});

test("bulk and single invoice flows share a stable QuickBooks payload", () => {
  const payload = buildQuickBooksInvoicePayload({
    id: "iv-1",
    number: "INV-1001",
    date: "8/29/2026",
    dueDate: "9/13/2026",
    taxRate: "6",
    lineItems: [{ desc: "Repair", qty: "2", unitPrice: "75", discountType: "pct", discount: "10", kind: "service", taxable: false }],
  }, client, { qbManagePayments: false, qbAllowCard: true, qbAllowACH: false });

  assert.equal(payload.spsInvoiceId, "iv-1");
  assert.equal(payload.date, "2026-08-29");
  assert.equal(payload.dueDate, "2026-09-13");
  assert.equal(payload.lineItems[0].unitPrice, "67.50");
  assert.equal(payload.allowCard, true);
  assert.equal(payload.allowACH, false);
});
