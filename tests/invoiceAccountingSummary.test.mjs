import test from "node:test";
import assert from "node:assert/strict";

import { formatAccountingCurrency, resolveInvoiceAccountingSummary } from "../invoiceAccountingSummary.js";

const fallback = {
  outstandingTotal: 10301.12,
  outstandingCount: 17,
  collectedMonth: 4120,
  overdueCount: 6,
};

test("a complete QuickBooks snapshot is the single source for Home and Invoices totals", () => {
  const result = resolveInvoiceAccountingSummary({
    complete: true,
    openInvoiceBalance: 9486.34,
    openInvoiceCount: 13,
    paymentsReceivedThisMonth: 6987.12,
    overdueInvoiceCount: 4,
  }, fallback);

  assert.deepEqual(result, {
    authoritative: true,
    outstandingTotal: 9486.34,
    outstandingCount: 13,
    collectedMonth: 6987.12,
    overdueCount: 4,
  });
});

test("an incomplete or stale accounting snapshot cannot override the local fallback", () => {
  assert.deepEqual(resolveInvoiceAccountingSummary({
    complete: false,
    stale: true,
    openInvoiceBalance: 1,
  }, fallback), {
    authoritative: false,
    outstandingTotal: fallback.outstandingTotal,
    outstandingCount: fallback.outstandingCount,
    collectedMonth: fallback.collectedMonth,
    overdueCount: fallback.overdueCount,
  });
});

test("a complete accounting snapshot expires after fifteen minutes", () => {
  const result = resolveInvoiceAccountingSummary({
    complete: true,
    fetchedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    openInvoiceBalance: 1,
  }, fallback);

  assert.equal(result.authoritative, false);
  assert.equal(result.outstandingTotal, fallback.outstandingTotal);
});

test("malformed QuickBooks values fail safely to the already calculated fallback", () => {
  const result = resolveInvoiceAccountingSummary({
    complete: true,
    openInvoiceBalance: "not-a-number",
    openInvoiceCount: -3,
    paymentsReceivedThisMonth: null,
    overdueInvoiceCount: "4",
  }, fallback);

  assert.equal(result.outstandingTotal, fallback.outstandingTotal);
  assert.equal(result.outstandingCount, fallback.outstandingCount);
  assert.equal(result.collectedMonth, 0);
  assert.equal(result.overdueCount, 4);
});

test("accounting cards use the same cents-accurate currency format", () => {
  assert.equal(formatAccountingCurrency(9486.34), "$9,486.34");
  assert.equal(formatAccountingCurrency(0), "$0.00");
});
