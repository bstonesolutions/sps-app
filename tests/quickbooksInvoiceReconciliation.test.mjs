import test from "node:test";
import assert from "node:assert/strict";

import {
  applyQuickBooksInvoiceSaveResult,
  hasPendingLocalInvoiceEdits,
  quickBooksInvoiceIntentSignature,
  reconcileQuickBooksInvoice,
} from "../quickbooksInvoiceReconciliation.js";

const localInvoice = () => ({
  id: "iv_est_estimate-42",
  qbId: "4949",
  number: "1964",
  clientId: "client-1",
  clientName: "Local client name",
  date: "07/21/2026",
  dueDate: "08/05/2026",
  status: "Sent",
  taxRate: "6",
  taxAmount: 85.02,
  subTotal: 1416.96,
  total: "1501.98",
  balance: 1501.98,
  notes: "SPS terms and private job notes",
  paymentLink: "https://spsway.app/pay/invoice-1964",
  source: "estimate",
  sourceEstimateId: "estimate-42",
  sourceVisitIds: ["visit-1", "visit-2"],
  lineItems: [{
    id: "local-service",
    qbLineId: "10",
    qbItemRef: { value: "8", name: "Services" },
    desc: "Pump service",
    qty: "1",
    unitPrice: "125",
    taxable: true,
    kind: "service",
    unitCost: "35",
    costKnown: true,
    knownUnitCost: "35",
    refId: "service-pump",
    bundleItems: [{ refId: "part-valve", qty: "1" }],
    sourceEstimateLineId: "estimate-line-1",
  }],
});

const quickBooksInvoice = () => ({
  qbId: "4949",
  qbCustomerId: "77",
  qbSyncToken: "4",
  qbLastUpdatedTime: "2026-07-27T15:21:00-04:00",
  qbContentFingerprint: "qb-content-fingerprint-4",
  number: "1964",
  clientName: "QuickBooks client name",
  date: "2026-07-27",
  dueDate: "2026-08-11",
  sentDate: "2026-07-27",
  paidDate: null,
  status: "Sent",
  taxRate: 0,
  taxAmount: 0,
  subTotal: 1501.98,
  total: 1501.98,
  balance: 1416.96,
  qbEmailStatus: "EmailSent",
  partial: true,
  paymentLink: "https://app.qbo.intuit.com/pay/4949",
  lineItems: [
    {
      id: "qbl_4949_0",
      qbLineId: "10",
      qbItemRef: { value: "8", name: "Services" },
      desc: "Pump service — revised in QuickBooks",
      qty: "2",
      unitPrice: "125",
      taxable: true,
      kind: "service",
    },
    {
      id: "qbl_4949_1",
      qbLineId: "11",
      qbItemRef: { value: "91", name: "Sales Tax" },
      desc: "Sales Tax",
      qty: "1",
      unitPrice: "85.02",
      taxable: false,
      kind: "custom",
    },
  ],
});

test("invoice create intent signatures are deterministic and normalize equivalent payloads", () => {
  const invoice = {
    spsInvoiceId: "local-1964",
    qbCustomerId: "42",
    number: "1964",
    clientName: "Generic Client",
    clientEmail: "OWNER@EXAMPLE.TEST",
    clientPhone: "(484) 555-0100",
    clientStreet: "10 Main Street",
    clientCity: "Honey Brook",
    clientState: "PA",
    clientZip: "19344",
    date: "2026-07-27",
    dueDate: "2026-08-11",
    taxRate: "6.0",
    invoiceDiscountType: "pct",
    invoiceDiscount: "5.00",
    allowCard: true,
    lineItems: [{
      description: "Pump   service",
      qty: "1.0",
      unitPrice: "125.00",
      amount: "125",
      taxable: true,
      kind: "Service",
      qbItemRef: { value: "8", name: "Services" },
    }],
  };
  const equivalent = {
    ...invoice,
    clientName: "  Generic   Client ",
    clientEmail: "owner@example.test",
    taxRate: 6,
    invoiceDiscount: 5,
    lineItems: [{
      ...invoice.lineItems[0],
      description: "Pump service",
      qty: 1,
      unitPrice: 125,
      amount: 125.0,
      kind: "service",
      qbItemRef: "8",
    }],
  };

  const first = quickBooksInvoiceIntentSignature(invoice);
  const second = quickBooksInvoiceIntentSignature(equivalent);

  assert.equal(first, second);
  assert.equal(first, quickBooksInvoiceIntentSignature(invoice));
  assert.deepEqual(JSON.parse(first), {
    version: 1,
    customer: {
      qbCustomerId: "42",
      name: "Generic Client",
      email: "owner@example.test",
      phone: "(484) 555-0100",
      street: "10 Main Street",
      city: "Honey Brook",
      state: "PA",
      zip: "19344",
    },
    invoice: {
      number: "1964",
      date: "2026-07-27",
      dueDate: "2026-08-11",
      taxRate: "6",
      discountType: "pct",
      discount: "5",
      allowCard: true,
      allowACH: null,
    },
    lines: [{
      description: "Pump service",
      qty: "1",
      unitPrice: "125",
      amount: "125",
      taxable: true,
      kind: "service",
      qbItemRef: "8",
    }],
  });
});

test("invoice create intent signatures change when customer-facing accounting intent changes", () => {
  const invoice = {
    qbCustomerId: "42",
    number: "1964",
    taxRate: 6,
    lineItems: [{
      description: "Pump service",
      qty: 1,
      unitPrice: 125,
      taxable: true,
      qbItemRef: { value: "8" },
    }],
  };
  const original = quickBooksInvoiceIntentSignature(invoice);

  assert.notEqual(
    original,
    quickBooksInvoiceIntentSignature({
      ...invoice,
      lineItems: [{ ...invoice.lineItems[0], unitPrice: 150 }],
    }),
  );
  assert.notEqual(
    original,
    quickBooksInvoiceIntentSignature({
      ...invoice,
      lineItems: [{ ...invoice.lineItems[0], qbItemRef: { value: "91" } }],
    }),
  );
  assert.notEqual(
    original,
    quickBooksInvoiceIntentSignature({
      ...invoice,
      lineItems: [
        ...invoice.lineItems,
        { description: "New QuickBooks service", qty: 1, unitPrice: 25 },
      ],
    }),
  );
});

test("adopts the authoritative QuickBooks snapshot and preserves SPS-only metadata", () => {
  const local = localInvoice();
  const remote = quickBooksInvoice();
  const result = reconcileQuickBooksInvoice(local, remote);

  assert.equal(result.id, "iv_est_estimate-42");
  assert.equal(result.source, "estimate");
  assert.equal(result.sourceEstimateId, "estimate-42");
  assert.deepEqual(result.sourceVisitIds, ["visit-1", "visit-2"]);
  assert.equal(result.clientId, "client-1");
  assert.equal(result.notes, "SPS terms and private job notes");
  assert.equal(result.paymentLink, "https://spsway.app/pay/invoice-1964");

  assert.equal(result.clientName, "QuickBooks client name");
  assert.equal(result.date, "2026-07-27");
  assert.equal(result.dueDate, "2026-08-11");
  assert.equal(result.status, "Sent");
  assert.equal(result.taxRate, 0);
  assert.equal(result.taxAmount, 0);
  assert.equal(result.subTotal, 1501.98);
  assert.equal(result.total, 1501.98);
  assert.equal(result.balance, 1416.96);
  assert.equal(result.qbSyncToken, "4");
  assert.equal(result.qbLastUpdatedTime, "2026-07-27T15:21:00-04:00");
  assert.equal(result.qbContentFingerprint, "qb-content-fingerprint-4");
  assert.equal(result.qbBaseContentFingerprint, "qb-content-fingerprint-4");

  assert.equal(result.lineItems.length, 2);
  assert.deepEqual(result.lineItems[0], {
    ...remote.lineItems[0],
    id: "local-service",
    unitCost: "35",
    costKnown: true,
    knownUnitCost: "35",
    refId: "service-pump",
    bundleItems: [{ refId: "part-valve", qty: "1" }],
    sourceEstimateLineId: "estimate-line-1",
  });
  assert.equal(result.lineItems[1].qbLineId, "11");
  assert.equal(result.lineItems[1].unitCost, "");
  assert.equal(result.lineItems[1].costKnown, false);
  assert.equal(Object.hasOwn(result.lineItems[1], "refId"), false);
  assert.equal(Object.hasOwn(result.lineItems[1], "bundleItems"), false);
  assert.equal(result.qbSyncStatus, "synced");
  assert.equal(result.qbAuthoritative, true);
  assert.equal(result.locallyEdited, false);

  assert.notStrictEqual(result, local);
  assert.notStrictEqual(result.lineItems, remote.lineItems);
  assert.deepEqual(local, localInvoice());
  assert.deepEqual(remote, quickBooksInvoice());
});

test("matches legacy lines by QuickBooks item ref and keeps a remote fallback payment link", () => {
  const local = {
    ...localInvoice(),
    paymentLink: "",
    lineItems: [{
      id: "legacy-line",
      qbItemRef: "8",
      desc: "Old description",
      qty: "1",
      unitPrice: "100",
      unitCost: "61.25",
      costKnown: true,
      refId: "service-legacy",
    }],
  };
  const remote = {
    ...quickBooksInvoice(),
    lineItems: [{
      id: "qbl_4949_0",
      qbLineId: "20",
      qbItemRef: { value: "8", name: "Services" },
      desc: "Renamed in QuickBooks",
      qty: "1",
      unitPrice: "130",
      taxable: false,
      kind: "service",
    }],
  };

  const result = reconcileQuickBooksInvoice(local, remote);

  assert.equal(result.lineItems[0].id, "legacy-line");
  assert.equal(result.lineItems[0].qbLineId, "20");
  assert.equal(result.lineItems[0].desc, "Renamed in QuickBooks");
  assert.equal(result.lineItems[0].unitPrice, "130");
  assert.equal(result.lineItems[0].unitCost, "61.25");
  assert.equal(result.lineItems[0].costKnown, true);
  assert.equal(result.lineItems[0].refId, "service-legacy");
  assert.equal(result.paymentLink, "https://app.qbo.intuit.com/pay/4949");
});

test("clears old SPS cost metadata when a QuickBooks line changes to a different item", () => {
  const local = localInvoice();
  const remote = {
    ...quickBooksInvoice(),
    lineItems: [{
      id: "qbl_4949_10",
      qbLineId: "10",
      qbItemRef: { value: "different-item", name: "Replacement service" },
      desc: "Replacement service",
      qty: "1",
      unitPrice: "300",
      taxable: false,
      kind: "service",
    }],
  };

  const result = reconcileQuickBooksInvoice(local, remote);

  assert.equal(result.lineItems[0].id, "local-service");
  assert.equal(result.lineItems[0].qbItemRef.value, "different-item");
  assert.equal(result.lineItems[0].unitCost, "");
  assert.equal(result.lineItems[0].costKnown, false);
  assert.equal(Object.hasOwn(result.lineItems[0], "refId"), false);
  assert.equal(Object.hasOwn(result.lineItems[0], "bundleItems"), false);
});

test("an unsent QuickBooks snapshot does not erase delivery recorded by SPS", () => {
  const local = {
    ...localInvoice(),
    status: "Sent",
    sentDate: "07/27/2026",
  };
  const remote = {
    ...quickBooksInvoice(),
    status: "Draft",
    qbEmailStatus: "NotSet",
  };
  delete remote.sentDate;

  const result = reconcileQuickBooksInvoice(local, remote);

  assert.equal(result.status, "Sent");
  assert.equal(result.sentDate, "07/27/2026");
});

test("is idempotent when the same QuickBooks snapshot is reconciled repeatedly", () => {
  const remote = quickBooksInvoice();
  const once = reconcileQuickBooksInvoice(localInvoice(), remote);
  const twice = reconcileQuickBooksInvoice(once, remote);

  assert.deepEqual(twice, once);
});

test("a successful save immediately adopts the canonical QuickBooks totals and lines while preserving SPS costs", () => {
  const local = {
    ...localInvoice(),
    total: 106,
    balance: 106,
    taxAmount: 6,
    subTotal: 100,
    locallyEdited: true,
    qbPendingLocalEdits: true,
    qbSyncStatus: "pending-push",
    lineItems: [{
      ...localInvoice().lineItems[0],
      desc: "Stale local description",
      qty: "1",
      unitPrice: "100",
      unitCost: "35",
      costKnown: true,
      refId: "service-pump",
    }],
  };
  const canonical = {
    ...quickBooksInvoice(),
    total: 159.45,
    balance: 59.45,
    taxAmount: 9.45,
    subTotal: 150,
    lineItems: [{
      id: "qbl_4949_10",
      qbLineId: "10",
      qbItemRef: { value: "8", name: "Services" },
      desc: "Canonical QuickBooks service",
      qty: "1",
      unitPrice: "150",
      taxable: true,
      kind: "service",
    }],
  };

  const result = applyQuickBooksInvoiceSaveResult(local, {
    qbId: "4949",
    paymentLink: "https://app.qbo.intuit.com/pay/4949",
    qbContentFingerprint: "canonical-fingerprint",
    invoice: canonical,
  });

  assert.equal(result.total, 159.45);
  assert.equal(result.balance, 59.45);
  assert.equal(result.taxAmount, 9.45);
  assert.equal(result.subTotal, 150);
  assert.equal(result.lineItems.length, 1);
  assert.equal(result.lineItems[0].id, "local-service");
  assert.equal(result.lineItems[0].desc, "Canonical QuickBooks service");
  assert.equal(result.lineItems[0].unitPrice, "150");
  assert.equal(result.lineItems[0].unitCost, "35");
  assert.equal(result.lineItems[0].costKnown, true);
  assert.equal(result.lineItems[0].refId, "service-pump");
  assert.equal(result.qbContentFingerprint, "canonical-fingerprint");
  assert.equal(result.qbBaseContentFingerprint, "canonical-fingerprint");
  assert.equal(result.qbAuthoritative, true);
  assert.equal(result.qbSyncStatus, "synced");
  assert.equal(result.locallyEdited, false);
  assert.equal(result.qbPendingLocalEdits, undefined);
});

test("does not overwrite an invoice with explicit pending local edits", () => {
  const local = {
    ...localInvoice(),
    locallyEdited: true,
    qbSyncStatus: "pending-push",
    status: "Draft",
    lineItems: [{
      ...localInvoice().lineItems[0],
      desc: "Unsaved SPS revision",
      unitPrice: "999",
    }],
  };
  const remote = quickBooksInvoice();
  const result = reconcileQuickBooksInvoice(local, remote);

  assert.deepEqual(result.lineItems, local.lineItems);
  assert.equal(result.status, "Draft");
  assert.equal(result.total, "1501.98");
  assert.equal(result.qbSyncStatus, "conflict");
  assert.equal(result.qbNeedsReview, true);
  assert.equal(result.qbRemoteChangesPending, true);
  assert.deepEqual(result.qbSyncConflict, {
    type: "quickbooks-remote-update",
    reason: "pending-local-edits",
    qbId: "4949",
    qbSyncToken: "4",
    qbLastUpdatedTime: "2026-07-27T15:21:00-04:00",
  });
  assert.equal(result.qbPendingRemoteInvoice.qbContentFingerprint, "qb-content-fingerprint-4");
  assert.equal(result.qbPendingRemoteInvoice.lineItems.length, 2);
  assert.equal(result.qbPendingRemoteInvoice.lineItems[1].unitCost, "");
  assert.equal(result.qbPendingRemoteInvoice.lineItems[1].costKnown, false);

  assert.deepEqual(reconcileQuickBooksInvoice(result, remote), result);
  assert.deepEqual(local.lineItems[0].desc, "Unsaved SPS revision");
});

test("recognizes only explicit local edit markers", () => {
  assert.equal(hasPendingLocalInvoiceEdits({ qbSyncStatus: "local" }), false);
  assert.equal(hasPendingLocalInvoiceEdits({ qbSyncStatus: "synced" }), false);
  assert.equal(hasPendingLocalInvoiceEdits({ locallyEdited: true }), true);
  assert.equal(hasPendingLocalInvoiceEdits({ qbPendingLocalEdits: true }), true);
  assert.equal(hasPendingLocalInvoiceEdits({ qbLocalChangesPending: true }), true);
  assert.equal(hasPendingLocalInvoiceEdits({ qbSyncStatus: "dirty" }), true);
});

test("rejects a QuickBooks snapshot that omitted lineItems", () => {
  assert.throws(
    () => reconcileQuickBooksInvoice(localInvoice(), { qbId: "4949" }),
    /must include lineItems/,
  );
});

test("refuses to reconcile a different QuickBooks invoice", () => {
  assert.throws(
    () => reconcileQuickBooksInvoice(localInvoice(), { ...quickBooksInvoice(), qbId: "other" }),
    /different QuickBooks ids/,
  );
});
