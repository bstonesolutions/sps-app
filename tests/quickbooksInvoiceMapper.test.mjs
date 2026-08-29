import assert from "node:assert/strict";
import test from "node:test";

import { mapQuickBooksInvoice } from "../api/quickbooks/invoice-mapper.js";

const baseInvoice = (lines) => ({
  Id: "invoice-1",
  SyncToken: "2",
  DocNumber: "2001",
  TxnDate: "2026-07-27",
  DueDate: "2026-08-11",
  CustomerRef: { value: "customer-1", name: "Generic Customer" },
  Balance: 95.40,
  TotalAmt: 95.40,
  ApplyTaxAfterDiscount: true,
  TxnTaxDetail: {
    TotalTax: 5.40,
    TxnTaxCodeRef: { value: "PA-SALES-TAX", name: "PA Sales Tax" },
    TaxLine: [{
      Amount: 5.40,
      DetailType: "TaxLineDetail",
      TaxLineDetail: {
        TaxPercent: 6,
      },
    }],
  },
  Line: lines,
});

test("maps a QuickBooks percentage discount and derives the effective 6% tax rate", () => {
  const invoice = baseInvoice([
    {
      Id: "line-1",
      Amount: 100,
      DetailType: "SalesItemLineDetail",
      Description: "Taxable service",
      SalesItemLineDetail: {
        ItemRef: { value: "8", name: "Services" },
        Qty: 1,
        UnitPrice: 100,
        TaxCodeRef: { value: "TAX" },
      },
    },
    {
      Id: "discount-1",
      Amount: 10,
      DetailType: "DiscountLineDetail",
      DiscountLineDetail: {
        PercentBased: true,
        DiscountPercent: 10,
      },
    },
  ]);

  const result = mapQuickBooksInvoice(invoice);

  assert.equal(result.discountType, "pct");
  assert.equal(result.discount, "10");
  assert.equal(result.taxRate, 6);
  assert.equal(result.taxAmount, 5.40);
  assert.equal(result.subTotal, 90);
  assert.equal(result.total, 95.40);
  assert.equal(result.balance, 95.40);
  assert.equal(result.lineItems.length, 1);
  assert.equal(result.lineItems[0].desc, "Taxable service");
  assert.equal(result.lineItems[0].taxable, true);
  assert.equal(result.qbHasUnsupportedLines, false);
  assert.deepEqual(result.qbUnsupportedLineTypes, []);
  assert.equal(result.status, "Draft");
});

test("only marks an unpaid QuickBooks invoice sent when QuickBooks has delivery evidence", () => {
  const options = { todayISO: "2026-07-27" };
  const unsent = mapQuickBooksInvoice(baseInvoice([]), options);
  const sent = mapQuickBooksInvoice({
    ...baseInvoice([]),
    EmailStatus: "EmailSent",
  }, options);
  const delivered = mapQuickBooksInvoice({
    ...baseInvoice([]),
    DeliveryInfo: {
      DeliveryTime: "2026-07-27T14:30:00-04:00",
      DeliveryType: "Email",
    },
  }, options);

  assert.equal(unsent.status, "Draft");
  assert.equal(Object.hasOwn(unsent, "sentDate"), false);
  assert.equal(sent.status, "Sent");
  assert.equal(delivered.status, "Sent");
  assert.equal(delivered.sentDate, "2026-07-27");
});

test("flags QuickBooks line types the SPS invoice editor cannot safely round-trip", () => {
  const invoice = {
    ...baseInvoice([
      {
        Id: "line-1",
        Amount: 100,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
          ItemRef: { value: "8", name: "Services" },
          Qty: 1,
          UnitPrice: 100,
          TaxCodeRef: { value: "TAX" },
        },
      },
      {
        Id: "subtotal-1",
        Amount: 100,
        DetailType: "SubTotalLineDetail",
        SubTotalLineDetail: {},
      },
      {
        Id: "description-only",
        Amount: 0,
        DetailType: "DescriptionOnly",
      },
    ]),
    TotalAmt: 106,
    Balance: 106,
    TxnTaxDetail: {
      ...baseInvoice([]).TxnTaxDetail,
      TotalTax: 6,
    },
  };

  const result = mapQuickBooksInvoice(invoice);

  assert.equal(result.qbHasUnsupportedLines, true);
  assert.deepEqual(
    result.qbUnsupportedLineTypes,
    ["SubTotalLineDetail", "DescriptionOnly"],
  );
});

test("accepts QuickBooks AST's generated trailing subtotal line", () => {
  const invoice = {
    ...baseInvoice([
      {
        Id: "line-1",
        Amount: 100,
        DetailType: "SalesItemLineDetail",
        Description: "Taxable service",
        SalesItemLineDetail: {
          ItemRef: { value: "8", name: "Services" },
          Qty: 1,
          UnitPrice: 100,
          TaxCodeRef: { value: "TAX" },
        },
      },
      {
        Id: "subtotal-generated",
        Amount: 100,
        DetailType: "SubTotalLineDetail",
        SubTotalLineDetail: {},
      },
    ]),
    TotalAmt: 106,
    Balance: 106,
    TxnTaxDetail: {
      ...baseInvoice([]).TxnTaxDetail,
      TotalTax: 6,
    },
  };

  const result = mapQuickBooksInvoice(invoice);

  assert.equal(result.qbHasUnsupportedLines, false);
  assert.deepEqual(result.qbUnsupportedLineTypes, []);
  assert.equal(result.lineItems.length, 1);
  assert.equal(result.taxRate, 6);
});

test("derives the editable rate from QuickBooks TotalTax when component rates differ", () => {
  const invoice = {
    ...baseInvoice([{
      Id: "line-1",
      Amount: 100,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: { value: "8", name: "Services" },
        Qty: 1,
        UnitPrice: 100,
        TaxCodeRef: { value: "TAX" },
      },
    }]),
    TotalAmt: 109.50,
    Balance: 109.50,
    TxnTaxDetail: {
      ...baseInvoice([]).TxnTaxDetail,
      TotalTax: 9.50,
      TaxLine: [{
        Amount: 9.10,
        DetailType: "TaxLineDetail",
        TaxLineDetail: { TaxPercent: 9.1 },
      }],
    },
  };

  const result = mapQuickBooksInvoice(invoice);

  assert.equal(result.taxAmount, 9.50);
  assert.equal(result.taxRate, 9.5);
});
