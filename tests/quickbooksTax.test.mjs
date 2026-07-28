import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUsTxnTaxDetail,
  calculateSpsInvoiceTax,
  resolveTransactionTaxCodeRef,
} from "../api/quickbooks/qb-tax.js";

test("calculates the SPS tax override from taxable lines and proportional invoice discount", () => {
  const result = calculateSpsInvoiceTax({
    taxRate: "6",
    sourceLines: [
      { qty: "1", unitPrice: "1,000", amount: "1000", taxable: true },
      { qty: "1", unitPrice: "500", taxable: true },
      { qty: "1", unitPrice: "100", taxable: false },
    ],
    invoiceDiscountType: "pct",
    invoiceDiscount: "10",
  });

  assert.deepEqual(result, {
    taxRate: 6,
    subtotal: 1600,
    discount: 160,
    taxableBase: 1350,
    totalTax: 81,
  });
});

test("produces the exact 6 percent override amount without turning tax into a service line", () => {
  const result = buildUsTxnTaxDetail({
    taxRate: 6,
    sourceLines: [{ qty: 1, unitPrice: 1417, taxable: true }],
    customer: { DefaultTaxCodeRef: { value: "PA-TAX-CODE", name: "PA Sales Tax" } },
  });

  assert.equal(result.status, "ready");
  assert.equal(result.taxableBase, 1417);
  assert.equal(result.totalTax, 85.02);
  assert.deepEqual(result.txnTaxDetail, {
    TxnTaxCodeRef: { value: "PA-TAX-CODE", name: "PA Sales Tax" },
    TotalTax: 85.02,
  });
});

test("prefers the current invoice's QuickBooks tax code over customer and stored fallbacks", () => {
  const ref = resolveTransactionTaxCodeRef({
    existingInvoice: {
      TxnTaxDetail: { TxnTaxCodeRef: { value: "CURRENT", name: "Current jurisdiction" } },
    },
    customer: { DefaultTaxCodeRef: { value: "CUSTOMER" } },
    storedTaxCodeRef: { value: "STORED" },
  });

  assert.deepEqual(ref, { value: "CURRENT", name: "Current jurisdiction" });
});

test("uses the QuickBooks customer's default code for a new invoice", () => {
  const result = buildUsTxnTaxDetail({
    taxRate: "6",
    sourceLines: [{ amount: 200, taxable: true }],
    customer: { DefaultTaxCodeRef: { value: "CUSTOMER-DEFAULT" } },
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(result.txnTaxDetail, {
    TxnTaxCodeRef: { value: "CUSTOMER-DEFAULT" },
    TotalTax: 12,
  });
});

test("fails closed instead of guessing a jurisdictional tax code", () => {
  const missing = buildUsTxnTaxDetail({
    taxRate: "6",
    sourceLines: [{ amount: 100, taxable: true }],
  });
  const pseudoOnly = buildUsTxnTaxDetail({
    taxRate: "6",
    sourceLines: [{ amount: 100, taxable: true }],
    customer: { DefaultTaxCodeRef: { value: "TAX" } },
  });

  assert.equal(missing.status, "blocked");
  assert.equal(missing.code, "QB_TAX_CODE_REQUIRED");
  assert.equal(missing.totalTax, 6);
  assert.equal(missing.txnTaxDetail, undefined);
  assert.equal(pseudoOnly.status, "blocked");
});

test("omits transaction tax when tax is disabled or no lines are taxable", () => {
  const disabled = buildUsTxnTaxDetail({
    taxRate: 0,
    sourceLines: [{ amount: 100, taxable: true }],
  });
  const nonTaxable = buildUsTxnTaxDetail({
    taxRate: 6,
    sourceLines: [{ amount: 100, taxable: false }],
  });

  assert.equal(disabled.status, "not_applicable");
  assert.equal(nonTaxable.status, "not_applicable");
  assert.equal(disabled.txnTaxDetail, undefined);
  assert.equal(nonTaxable.txnTaxDetail, undefined);
});

test("blocks malformed or out-of-range rates instead of silently disabling tax", () => {
  for (const taxRate of ["6oops", "-1", "101"]) {
    const result = buildUsTxnTaxDetail({
      taxRate,
      sourceLines: [{ amount: 100, taxable: true }],
      customer: { DefaultTaxCodeRef: { value: "CUSTOMER-DEFAULT" } },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "QB_TAX_RATE_INVALID");
  }
});
