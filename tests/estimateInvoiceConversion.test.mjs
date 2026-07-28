import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateDraftInvoiceId,
  estimateToDraftInvoice,
  findInvoiceForEstimate,
} from "../estimateInvoiceConversion.js";

test("approved estimate becomes one local draft with client, catalog, cost, notes, and tax preserved", () => {
  const estimate = {
    id: "est-42",
    number: "EST-1042",
    clientId: 7,
    clientName: "Jordan Hale",
    title: "Pond repair",
    status: "approved",
    taxEnabled: true,
    taxRate: "6",
    notes: "Replace the failed pump.",
    items: [
      {
        id: "service-line",
        desc: "Pump replacement",
        qty: "2",
        price: "125",
        unitCost: "70",
        costKnown: true,
        kind: "service",
        refId: "svc-pump",
        unit: "service",
      },
      {
        id: "bundle-line",
        desc: "Parts & Materials — valve ×2",
        qty: "1",
        price: "40",
        unitCost: "",
        costKnown: false,
        knownUnitCost: "12",
        kind: "bundle",
        bundleNote: "valve ×2",
        bundleItems: [{ refId: "part-valve", name: "Valve", qty: "2" }],
      },
    ],
  };
  const invoice = estimateToDraftInvoice(estimate, {
    client: { id: 7, name: "Jordan Hale", email: "jordan@example.com", address: "10 Main St" },
    number: "INV-2042",
    issueDate: "07/27/2026",
    dueDate: "08/11/2026",
    dueDays: 15,
    defaultTaxRate: "6",
    paymentTerms: "Payment is due within 15 days.",
    createdAt: Date.parse("2026-07-27T12:00:00.000Z"),
  });

  assert.equal(invoice.id, "iv_est_est-42");
  assert.equal(invoice.status, "Draft");
  assert.equal(invoice.clientId, 7);
  assert.equal(invoice.clientEmail, "jordan@example.com");
  assert.equal(invoice.number, "INV-2042");
  assert.equal(invoice.taxRate, "6");
  assert.equal(invoice.lineItems.length, 2);
  assert.equal(invoice.lineItems[0].unitPrice, "125");
  assert.equal(invoice.lineItems[0].unitCost, "70");
  assert.equal(invoice.lineItems[0].taxable, true);
  assert.equal(invoice.lineItems[0].refId, "svc-pump");
  assert.equal(invoice.lineItems[1].costKnown, false);
  assert.equal(invoice.lineItems[1].unitCost, "");
  assert.equal(invoice.lineItems[1].taxable, true);
  assert.deepEqual(invoice.lineItems[1].bundleItems, [{ refId: "part-valve", name: "Valve", qty: "2" }]);
  assert.notEqual(invoice.lineItems[1].bundleItems, estimate.items[1].bundleItems);
  assert.match(invoice.notes, /Replace the failed pump/);
  assert.match(invoice.notes, /Payment is due within 15 days/);
  assert.equal(invoice.sourceEstimateId, "est-42");
  assert.equal(invoice.sourceEstimateNumber, "EST-1042");
  assert.equal(invoice.convertedFromEstimate, true);
  assert.equal(invoice.qbSyncStatus, "local");
  assert.equal("qbId" in invoice, false);
  assert.equal("qbPushed" in invoice, false);
});

test("tax-off and legacy amount-only estimates remain tax-free and keep their quoted cents", () => {
  const invoice = estimateToDraftInvoice({
    id: "legacy-estimate",
    number: "EST-9",
    clientId: "client-1",
    status: "sent",
    taxRate: "9",
    items: [{ id: "legacy", description: "Legacy quoted work", qty: "2", amount: "75" }],
  }, {
    client: { id: "client-1", name: "Generic Client" },
    number: "INV-9",
    issueDate: "07/27/2026",
    dueDate: "08/11/2026",
  });

  assert.equal(invoice.taxRate, "0");
  assert.equal(invoice.lineItems[0].taxable, false);
  assert.equal(invoice.lineItems[0].qty, "2");
  assert.equal(invoice.lineItems[0].unitPrice, "37.5");
});

test("conversion identity is deterministic and an existing linked invoice is reused", () => {
  const estimate = { id: "est:shared/42", number: "EST-42" };
  const id = estimateDraftInvoiceId(estimate);
  assert.equal(id, "iv_est_est_shared_42");

  const linked = { id, sourceEstimateId: estimate.id, number: "INV-77", status: "Sent" };
  assert.equal(findInvoiceForEstimate([linked], estimate), linked);
  assert.equal(findInvoiceForEstimate([{ id: "other" }], estimate), null);

  const legacy = { id: estimateDraftInvoiceId({ number: "EST-7" }), number: "INV-78" };
  assert.equal(findInvoiceForEstimate([legacy], { number: "EST-7" }), legacy);
});

test("conversion fails closed for missing client, empty work, or a cents mismatch", () => {
  const base = { id: "est-1", items: [{ desc: "Work", qty: "1", price: "10" }] };
  assert.throws(() => estimateToDraftInvoice(base, { number: "INV-1" }), /Choose a client/);
  assert.throws(() => estimateToDraftInvoice({ id: "empty", items: [] }, {
    client: { id: 1, name: "Client" },
    number: "INV-2",
  }), /line item/);
  assert.throws(() => estimateToDraftInvoice({
    id: "fractional",
    taxEnabled: false,
    items: [
      { id: "one", desc: "One", qty: "1", price: "0.005" },
      { id: "two", desc: "Two", qty: "1", price: "0.005" },
    ],
  }, {
    client: { id: 1, name: "Client" },
    number: "INV-3",
  }), /totals do not match/);
});
