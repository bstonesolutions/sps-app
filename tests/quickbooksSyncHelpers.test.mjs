import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuickBooksPagedQuery,
  buildQuickBooksReconciliationMetadata,
  fetchAllQuickBooksQueryPages,
  mapQuickBooksCreditMemo,
  mapQuickBooksPayment,
  summarizeQuickBooksAccounting,
} from "../api/quickbooks/sync-helpers.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test("paged QuickBooks queries advance past a full page instead of silently truncating", async () => {
  const requestedQueries = [];
  const records = Array.from({ length: 1001 }, (_, index) => ({ Id: String(index + 1) }));

  const result = await fetchAllQuickBooksQueryPages({
    fetchImpl: async (href) => {
      const query = new URL(href).searchParams.get("query");
      requestedQueries.push(query);
      const start = Number(query.match(/STARTPOSITION (\d+)/)?.[1] || 1);
      const page = records.slice(start - 1, start - 1 + 1000);
      return jsonResponse({
        QueryResponse: {
          Invoice: page,
          startPosition: start,
          maxResults: page.length,
        },
      });
    },
    base: "https://quickbooks.test/v3/company/realm-1",
    headers: { Authorization: "Bearer test" },
    entity: "Invoice",
    orderBy: "MetaData.LastUpdatedTime DESC",
  });

  assert.equal(result.records.length, 1001);
  assert.equal(result.pageCount, 2);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.match(requestedQueries[0], /STARTPOSITION 1 MAXRESULTS 1000$/);
  assert.match(requestedQueries[1], /STARTPOSITION 1001 MAXRESULTS 1000$/);
});

test("QuickBooks query builder keeps WHERE and ORDER BY ahead of pagination", () => {
  assert.equal(
    buildQuickBooksPagedQuery({
      entity: "Customer",
      where: "Active = true",
      orderBy: "DisplayName ASC",
      startPosition: 1001,
      maxResults: 1000,
    }),
    "SELECT * FROM Customer WHERE Active = true ORDER BY DisplayName ASC STARTPOSITION 1001 MAXRESULTS 1000",
  );
});

test("credit memos expose authoritative remaining credit and applied amount", () => {
  const mapped = mapQuickBooksCreditMemo({
    Id: "88",
    SyncToken: "4",
    MetaData: { LastUpdatedTime: "2026-07-28T12:00:00-04:00" },
    DocNumber: "CM-104",
    TxnDate: "2026-07-28",
    TotalAmt: 300,
    RemainingCredit: 74.46,
    CustomerRef: { value: "42", name: "Generic Client" },
  });

  assert.deepEqual(mapped, {
    qbId: "88",
    qbSyncToken: "4",
    qbLastUpdatedTime: "2026-07-28T12:00:00-04:00",
    number: "CM-104",
    qbCustomerId: "42",
    clientName: "Generic Client",
    date: "2026-07-28",
    total: 300,
    remainingCredit: 74.46,
    appliedAmount: 225.54,
    status: "Partially applied",
    source: "quickbooks-credit-memo",
  });
});

test("payments expose the applied and unapplied amounts QuickBooks uses as customer credits", () => {
  const mapped = mapQuickBooksPayment({
    Id: "p-7",
    SyncToken: "3",
    MetaData: { LastUpdatedTime: "2026-07-28T13:00:00-04:00" },
    PaymentRefNum: "Check 400",
    TxnDate: "2026-07-28",
    TotalAmt: 200,
    UnappliedAmt: 143.05,
    PaymentMethodRef: { value: "3", name: "Check" },
    DepositToAccountRef: { value: "35", name: "Checking" },
    PrivateNote: "Spring maintenance prepayment",
    Line: [{
      Amount: 56.95,
      LinkedTxn: [{ TxnId: "invoice-42", TxnType: "Invoice" }],
    }],
    CustomerRef: { value: "42", name: "Generic Client" },
  });

  assert.deepEqual(mapped, {
    qbId: "p-7",
    qbSyncToken: "3",
    qbLastUpdatedTime: "2026-07-28T13:00:00-04:00",
    number: "Check 400",
    qbCustomerId: "42",
    clientName: "Generic Client",
    date: "2026-07-28",
    total: 200,
    appliedAmount: 56.95,
    unappliedAmount: 143.05,
    invoiceAllocations: [{ qbInvoiceId: "invoice-42", amount: 56.95 }],
    allocationReviewRequired: false,
    paymentMethod: "Check",
    qbPaymentMethodId: "3",
    depositAccount: "Checking",
    qbDepositAccountId: "35",
    note: "Spring maintenance prepayment",
    status: "Partially applied",
    source: "quickbooks-payment",
  });
});

test("payments retain ambiguous QuickBooks invoice links but require allocation review", () => {
  const mapped = mapQuickBooksPayment({
    Id: "p-split",
    TotalAmt: 400,
    UnappliedAmt: 0,
    Line: [{
      Amount: 400,
      LinkedTxn: [
        { TxnId: "invoice-a", TxnType: "Invoice" },
        { TxnId: "invoice-b", TxnType: "Invoice" },
      ],
    }],
  });

  assert.deepEqual(mapped.invoiceAllocations, [
    { qbInvoiceId: "invoice-a", amount: null },
    { qbInvoiceId: "invoice-b", amount: null },
  ]);
  assert.equal(mapped.allocationReviewRequired, true);
});

test("accounting totals distinguish gross invoice balance, credits, and net receivables", () => {
  const accounting = summarizeQuickBooksAccounting({
    todayISO: "2026-07-28",
    invoices: [
      { qbId: "1", total: 100, balance: 100, dueDate: "2026-07-20" },
      { qbId: "2", total: 200.01, balance: 50.01, dueDate: "2026-08-01" },
      { qbId: "3", total: 80, balance: 0, dueDate: "2026-07-01" },
    ],
    creditMemos: [
      { qbId: "c1", total: 40, remainingCredit: 24.47 },
      { qbId: "c2", total: 10, remainingCredit: 0 },
    ],
    payments: [
      {
        qbId: "p1",
        date: "2026-07-28",
        total: 200,
        appliedAmount: 175,
        unappliedAmount: 25,
      },
      {
        qbId: "p2",
        date: "2026-06-30",
        total: 60,
        appliedAmount: 60,
        unappliedAmount: 0,
      },
    ],
  });

  assert.deepEqual(accounting, {
    currency: "USD",
    complete: true,
    invoiceCount: 3,
    invoiceTotal: 380.01,
    openInvoiceCount: 2,
    openInvoiceBalance: 150.01,
    overdueInvoiceCount: 1,
    overdueInvoiceBalance: 100,
    creditMemoCount: 2,
    creditMemoTotal: 50,
    openCreditMemoCount: 1,
    availableCreditMemoBalance: 24.47,
    paymentCount: 2,
    paymentTotal: 260,
    unappliedPaymentCount: 1,
    unappliedPaymentBalance: 25,
    openCreditCount: 2,
    openTransactionCount: 4,
    availableCreditBalance: 49.47,
    netOpenReceivables: 100.54,
    paymentCountThisMonth: 1,
    paymentsReceivedThisMonth: 200,
    paymentsAppliedThisMonth: 175,
  });
});

test("reconciliation metadata carries the exact current QB ids and completeness warnings", () => {
  const metadata = buildQuickBooksReconciliationMetadata({
    fetchedAt: "2026-07-28T16:00:00.000Z",
    todayISO: "2026-07-28",
    invoices: [{ qbId: "1", total: 100, balance: 100, dueDate: "2026-08-01" }],
    customers: [{ qbId: "42" }],
    creditMemos: [],
    payments: [],
    fetches: {
      invoices: { count: 1, pageCount: 1, complete: true, truncated: false },
      customers: { count: 1, pageCount: 1, complete: true, truncated: false },
      payments: { count: 0, pageCount: 0, complete: false, error: "Payment query failed" },
      creditMemos: { count: 0, pageCount: 1, complete: true, truncated: false },
    },
  });

  assert.deepEqual(metadata.qbInvoiceIds, ["1"]);
  assert.deepEqual(metadata.qbCustomerIds, ["42"]);
  assert.deepEqual(metadata.qbCreditMemoIds, []);
  assert.deepEqual(metadata.qbPaymentIds, []);
  assert.equal(metadata.accounting.openInvoiceBalance, 100);
  assert.equal(metadata.accounting.complete, false);
  assert.equal(metadata.complete, false);
  assert.deepEqual(metadata.warnings, ["payments: Payment query failed"]);
});
