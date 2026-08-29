import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  fingerprintQuickBooksInvoiceContent,
} from "../api/quickbooks/invoice-revision.js";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.API_AUTH_ENFORCED = "true";
process.env.QB_API_BASE = "https://quickbooks.test";

const { default: syncHandler } = await import("../api/quickbooks/sync.js");
const { default: updateInvoiceHandler } = await import("../api/quickbooks/update-invoice.js");
const { default: createInvoiceHandler } = await import("../api/quickbooks/create-invoice.js");

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function authenticatedRequest(body = undefined) {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer owner-token" },
    query: {},
    ...(body === undefined ? {} : { body }),
  };
}

function quickBooksTokenRow() {
  return [{
    id: "default",
    realm_id: "realm-1",
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: "2099-01-01T00:00:00.000Z",
  }];
}

function installAuthAndTokenMocks(routeFetch) {
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href === "https://supabase.test/auth/v1/user") {
      return jsonResponse({ id: "owner-1", email: "owner@example.test" });
    }
    if (href.startsWith("https://supabase.test/rest/v1/qb_tokens")) {
      return jsonResponse(quickBooksTokenRow());
    }
    return routeFetch(href, options);
  };
}

function existingInvoice() {
  return {
    Id: "1964",
    SyncToken: "7",
    MetaData: { LastUpdatedTime: "2026-07-27T10:00:00-04:00" },
    CustomerRef: { value: "42", name: "Generic Client" },
    DocNumber: "1964",
    TxnDate: "2026-07-27",
    DueDate: "2026-08-11",
    TotalAmt: 1417,
    Balance: 1417,
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
      TotalTax: 0,
    },
    Line: [{
      Id: "22",
      LineNum: 1,
      Amount: 1417,
      DetailType: "SalesItemLineDetail",
      Description: "Skimmer installation",
      SalesItemLineDetail: {
        ItemRef: { value: "8", name: "Services" },
        Qty: 1,
        UnitPrice: 1417,
        TaxCodeRef: { value: "NON" },
      },
    }],
  };
}

test("QuickBooks sync emits stable line identity, item identity, tax code, and content fingerprint", async () => {
  const invoice = {
    ...existingInvoice(),
    TotalAmt: 1502.02,
    Balance: 1502.02,
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
      TotalTax: 85.02,
    },
    Line: [{
      ...existingInvoice().Line[0],
      SalesItemLineDetail: {
        ...existingInvoice().Line[0].SalesItemLineDetail,
        TaxCodeRef: { value: "TAX" },
      },
    }],
  };

  installAuthAndTokenMocks(async (href) => {
    const url = new URL(href);
    if (url.pathname.endsWith("/query")) {
      const query = url.searchParams.get("query") || "";
      if (query.includes("FROM Invoice")) {
        return jsonResponse({ QueryResponse: { Invoice: [invoice] } });
      }
      if (query.includes("FROM Customer")) {
        return jsonResponse({ QueryResponse: { Customer: [] } });
      }
      if (query.includes("FROM Payment")) {
        return jsonResponse({ QueryResponse: { Payment: [] } });
      }
      if (query.includes("FROM CreditMemo")) {
        return jsonResponse({ QueryResponse: { CreditMemo: [] } });
      }
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const firstRes = mockResponse();
  await syncHandler(authenticatedRequest(), firstRes);
  const secondRes = mockResponse();
  await syncHandler(authenticatedRequest(), secondRes);

  assert.equal(firstRes.statusCode, 200);
  assert.equal(secondRes.statusCode, 200);
  assert.equal(firstRes.body.invoices.length, 1);
  const first = firstRes.body.invoices[0];
  const second = secondRes.body.invoices[0];

  assert.equal(first.lineItems[0].id, "qbl_1964_22");
  assert.equal(first.lineItems[0].qbLineId, "22");
  assert.deepEqual(first.lineItems[0].qbItemRef, { value: "8", name: "Services" });
  assert.deepEqual(first.qbTaxCodeRef, { value: "PA-CODE", name: "PA Sales Tax" });
  assert.equal(first.qbContentFingerprint, fingerprintQuickBooksInvoiceContent(invoice));
  assert.equal(second.lineItems[0].id, first.lineItems[0].id);
  assert.equal(second.qbContentFingerprint, first.qbContentFingerprint);
  assert.deepEqual(firstRes.body.creditMemos, []);
  assert.deepEqual(firstRes.body.unappliedPayments, []);
  assert.deepEqual(firstRes.body.payments, []);
  assert.deepEqual(firstRes.body.reconciliation.qbInvoiceIds, ["1964"]);
  assert.equal(firstRes.body.reconciliation.complete, true);
  assert.equal(firstRes.body.accounting.openInvoiceBalance, 1502.02);
});

test("targeted invoice review reads one linked invoice without downloading the ledger", async () => {
  const invoice = existingInvoice();
  installAuthAndTokenMocks(async (href) => {
    const url = new URL(href);
    if (url.pathname.endsWith("/invoice/1964")) {
      return jsonResponse({ Invoice: invoice });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const req = authenticatedRequest();
  req.query = {
    reviewInvoiceId: "1964",
    reviewInvoiceNumber: "1964",
    reviewCustomerId: "42",
    reviewTotal: "1417",
  };
  const res = mockResponse();
  await syncHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, "invoice-review");
  assert.equal(res.body.linkedStatus, "found");
  assert.equal(res.body.invoice.qbId, "1964");
  assert.equal(res.body.candidates.length, 1);
  assert.equal(res.body.candidates[0].safeToLink, true);
});

test("targeted invoice review accepts private POST criteria instead of URL query parameters", async () => {
  const invoice = existingInvoice();
  installAuthAndTokenMocks(async (href) => {
    const url = new URL(href);
    if (url.pathname.endsWith("/invoice/1964")) {
      return jsonResponse({ Invoice: invoice });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const req = authenticatedRequest({
    mode: "invoice-review",
    reviewInvoiceId: "1964",
    reviewInvoiceNumber: "1964",
    reviewCustomerId: "42",
    reviewClientName: "Generic Client",
    reviewTotal: "1417",
  });
  const res = mockResponse();
  await syncHandler(req, res);

  assert.deepEqual(req.query, {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, "invoice-review");
  assert.equal(res.body.linkedStatus, "found");
  assert.equal(res.body.invoice.qbId, "1964");
});

test("targeted review scores a unique replacement only by number, customer and total", async () => {
  const replacement = { ...existingInvoice(), Id: "replacement-1964" };
  installAuthAndTokenMocks(async (href) => {
    const url = new URL(href);
    if (url.pathname.endsWith("/invoice/missing-1964")) {
      // QuickBooks commonly reports a missing object as HTTP 400 + fault 610,
      // rather than a conventional HTTP 404.
      return jsonResponse({
        Fault: {
          Error: [{
            code: "610",
            Message: "Object Not Found",
            Detail: "The invoice could not be found.",
          }],
        },
      }, 400);
    }
    if (url.pathname.endsWith("/query")) {
      const query = url.searchParams.get("query") || "";
      assert.match(query, /FROM Invoice WHERE DocNumber = '1964'/);
      return jsonResponse({ QueryResponse: { Invoice: [replacement] } });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const req = authenticatedRequest();
  req.query = {
    reviewInvoiceId: "missing-1964",
    reviewInvoiceNumber: "1964",
    reviewCustomerId: "42",
    reviewTotal: "1417",
  };
  const res = mockResponse();
  await syncHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linkedStatus, "missing");
  assert.equal(res.body.safeCandidate.qbId, "replacement-1964");
  assert.equal(res.body.candidates[0].safeToLink, true);
  assert.deepEqual(res.body.candidates[0].assessment.evidence, [
    "document-number",
    "customer",
    "total",
  ]);
});

test("targeted review never marks a document-number-only candidate safe", async () => {
  const differentCustomer = {
    ...existingInvoice(),
    Id: "candidate-1964",
    CustomerRef: { value: "other-customer", name: "Other Client" },
  };
  installAuthAndTokenMocks(async (href) => {
    const url = new URL(href);
    if (url.pathname.endsWith("/query")) {
      return jsonResponse({ QueryResponse: { Invoice: [differentCustomer] } });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const req = authenticatedRequest();
  req.query = {
    reviewInvoiceNumber: "1964",
    reviewCustomerId: "42",
    reviewTotal: "1417",
  };
  const res = mockResponse();
  await syncHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.safeCandidate, null);
  assert.equal(res.body.candidates[0].safeToLink, false);
  assert.equal(res.body.candidates[0].assessment.eligible, false);
});

test("QuickBooks sync returns credit memos and exact net receivables metadata", async () => {
  const invoice = {
    ...existingInvoice(),
    TotalAmt: 500,
    Balance: 274.46,
  };
  const creditMemo = {
    Id: "cm-9",
    SyncToken: "2",
    MetaData: { LastUpdatedTime: "2026-07-28T13:00:00-04:00" },
    DocNumber: "CM-9",
    TxnDate: "2026-07-28",
    TotalAmt: 100,
    RemainingCredit: 74.46,
    CustomerRef: { value: "42", name: "Generic Client" },
  };

  installAuthAndTokenMocks(async (href) => {
    const url = new URL(href);
    if (url.pathname.endsWith("/query")) {
      const query = url.searchParams.get("query") || "";
      if (query.includes("FROM Invoice")) {
        return jsonResponse({ QueryResponse: { Invoice: [invoice] } });
      }
      if (query.includes("FROM Customer")) {
        return jsonResponse({ QueryResponse: { Customer: [] } });
      }
      if (query.includes("FROM Payment")) {
        return jsonResponse({ QueryResponse: { Payment: [] } });
      }
      if (query.includes("FROM CreditMemo")) {
        return jsonResponse({ QueryResponse: { CreditMemo: [creditMemo] } });
      }
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const res = mockResponse();
  await syncHandler(authenticatedRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.creditMemos.length, 1);
  assert.equal(res.body.creditMemos[0].remainingCredit, 74.46);
  assert.deepEqual(res.body.reconciliation.qbInvoiceIds, ["1964"]);
  assert.deepEqual(res.body.reconciliation.qbCreditMemoIds, ["cm-9"]);
  assert.equal(res.body.accounting.openInvoiceBalance, 274.46);
  assert.equal(res.body.accounting.availableCreditBalance, 74.46);
  assert.equal(res.body.accounting.netOpenReceivables, 200);
  assert.equal(res.body.accounting.complete, true);
});

test("QuickBooks sync subtracts unapplied payments from net receivables", async () => {
  const currentDate = new Date().toISOString().slice(0, 10);
  const invoice = {
    ...existingInvoice(),
    TotalAmt: 500,
    Balance: 500,
  };
  const payment = {
    Id: "payment-9",
    SyncToken: "2",
    MetaData: { LastUpdatedTime: "2026-07-28T13:00:00-04:00" },
    PaymentRefNum: "ACH-9",
    TxnDate: currentDate,
    TotalAmt: 143.05,
    UnappliedAmt: 143.05,
    CustomerRef: { value: "42", name: "Generic Client" },
    Line: [],
  };

  installAuthAndTokenMocks(async (href) => {
    const url = new URL(href);
    if (url.pathname.endsWith("/query")) {
      const query = url.searchParams.get("query") || "";
      if (query.includes("FROM Invoice")) {
        return jsonResponse({ QueryResponse: { Invoice: [invoice] } });
      }
      if (query.includes("FROM Customer")) {
        return jsonResponse({ QueryResponse: { Customer: [] } });
      }
      if (query.includes("FROM Payment")) {
        return jsonResponse({ QueryResponse: { Payment: [payment] } });
      }
      if (query.includes("FROM CreditMemo")) {
        return jsonResponse({ QueryResponse: { CreditMemo: [] } });
      }
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const res = mockResponse();
  await syncHandler(authenticatedRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.unappliedPayments.length, 1);
  assert.equal(res.body.unappliedPayments[0].unappliedAmount, 143.05);
  assert.equal(res.body.payments.length, 1);
  assert.equal(res.body.payments[0].qbId, "payment-9");
  assert.equal(res.body.accounting.openInvoiceBalance, 500);
  assert.equal(res.body.accounting.availableCreditBalance, 143.05);
  assert.equal(res.body.accounting.netOpenReceivables, 356.95);
  assert.equal(res.body.accounting.openTransactionCount, 2);
  assert.equal(res.body.accounting.paymentsReceivedThisMonth, 143.05);
  assert.equal(res.body.accounting.complete, true);
  assert.deepEqual(res.body.reconciliation.qbPaymentIds, ["payment-9"]);
});

test("QuickBooks update preserves line/item ids, uses sparse update, sends exact native tax, and returns canonical fingerprint", async () => {
  const before = {
    ...existingInvoice(),
    // QuickBooks AST automatically appends this plain trailing subtotal. SPS
    // may omit it from the write because QuickBooks regenerates it.
    Line: [
      ...existingInvoice().Line,
      {
        Id: "23",
        LineNum: 2,
        Amount: 1417,
        DetailType: "SubTotalLineDetail",
        SubTotalLineDetail: {},
      },
    ],
  };
  const canonical = {
    ...before,
    SyncToken: "8",
    MetaData: { LastUpdatedTime: "2026-07-27T11:00:00-04:00" },
    TotalAmt: 1502.02,
    Balance: 1502.02,
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
      TotalTax: 85.02,
    },
    Line: [{
      ...before.Line[0],
      SalesItemLineDetail: {
        ...before.Line[0].SalesItemLineDetail,
        TaxCodeRef: { value: "TAX" },
      },
    }],
  };
  let invoiceReadCount = 0;
  let updateBody = null;

  installAuthAndTokenMocks(async (href, options = {}) => {
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice/1964?minorversion=65") {
      invoiceReadCount += 1;
      return jsonResponse({ Invoice: invoiceReadCount === 1 ? before : canonical });
    }
    if (href === "https://quickbooks.test/v3/company/realm-1/customer/42?minorversion=65") {
      return jsonResponse({
        Customer: {
          Id: "42",
          DefaultTaxCodeRef: { value: "CUSTOMER-CODE", name: "Customer fallback" },
        },
      });
    }
    if (
      href === "https://quickbooks.test/v3/company/realm-1/invoice?minorversion=65"
      && options.method === "POST"
    ) {
      updateBody = JSON.parse(options.body);
      return jsonResponse({ Invoice: { Id: "1964", SyncToken: "8" } });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const res = mockResponse();
  await updateInvoiceHandler(authenticatedRequest({
    invoice: {
      qbId: "1964",
      qbBaseContentFingerprint: fingerprintQuickBooksInvoiceContent(before),
      qbTaxCodeRef: { value: "STORED-CODE", name: "Stored fallback" },
      number: "1964",
      date: "2026-07-27",
      dueDate: "2026-08-11",
      taxRate: "6",
      lineItems: [{
        qbLineId: "22",
        qbItemRef: { value: "8", name: "Services" },
        description: "Skimmer installation",
        kind: "service",
        qty: "1",
        unitPrice: "1417",
        taxable: true,
      }],
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(invoiceReadCount, 2);
  assert.equal(updateBody.sparse, true);
  assert.equal(updateBody.Line[0].Id, "22");
  assert.deepEqual(updateBody.Line[0].SalesItemLineDetail.ItemRef, {
    value: "8",
    name: "Services",
  });
  assert.deepEqual(updateBody.Line[0].SalesItemLineDetail.TaxCodeRef, { value: "TAX" });
  assert.deepEqual(updateBody.TxnTaxDetail, {
    TxnTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
    TotalTax: 85.02,
  });
  assert.equal(res.body.qbContentFingerprint, fingerprintQuickBooksInvoiceContent(canonical));
  assert.equal(res.body.invoice.total, 1502.02);
  assert.equal(res.body.invoice.balance, 1502.02);
  assert.equal(res.body.invoice.lineItems.length, 1);
  assert.equal(res.body.invoice.qbHasUnsupportedLines, false);
});

test("QuickBooks update refuses complex lines before issuing a write", async () => {
  const before = {
    ...existingInvoice(),
    Line: [
      ...existingInvoice().Line,
      {
        Id: "group-1",
        DetailType: "GroupLineDetail",
        Description: "Custom grouped section",
        GroupLineDetail: { GroupItemRef: { value: "90", name: "Project group" } },
      },
    ],
  };
  let wroteInvoice = false;

  installAuthAndTokenMocks(async (href, options = {}) => {
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice/1964?minorversion=65") {
      return jsonResponse({ Invoice: before });
    }
    if (href.endsWith("/invoice?minorversion=65") && options.method === "POST") {
      wroteInvoice = true;
      return jsonResponse({});
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const res = mockResponse();
  await updateInvoiceHandler(authenticatedRequest({
    invoice: {
      qbId: "1964",
      qbBaseContentFingerprint: fingerprintQuickBooksInvoiceContent(before),
      lineItems: [{
        qbLineId: "22",
        qbItemRef: { value: "8", name: "Services" },
        description: "Skimmer installation",
        qty: "1",
        unitPrice: "1417",
        taxable: false,
      }],
    },
  }), res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, "QB_COMPLEX_LINES_UNSUPPORTED");
  assert.equal(res.body.reviewRequired, false);
  assert.deepEqual(res.body.unsupportedLineTypes, ["GroupLineDetail"]);
  assert.equal(wroteInvoice, false);
});

test("QuickBooks update clears prior tax when every remaining line is non-taxable", async () => {
  const before = {
    ...existingInvoice(),
    TotalAmt: 106,
    Balance: 106,
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
      TotalTax: 6,
    },
    Line: [{
      ...existingInvoice().Line[0],
      Amount: 100,
      SalesItemLineDetail: {
        ...existingInvoice().Line[0].SalesItemLineDetail,
        Qty: 1,
        UnitPrice: 100,
        TaxCodeRef: { value: "TAX" },
      },
    }],
  };
  const canonical = {
    ...before,
    SyncToken: "8",
    TotalAmt: 100,
    Balance: 100,
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
      TotalTax: 0,
    },
    Line: [{
      ...before.Line[0],
      SalesItemLineDetail: {
        ...before.Line[0].SalesItemLineDetail,
        TaxCodeRef: { value: "NON" },
      },
    }],
  };
  let reads = 0;
  let updateBody = null;

  installAuthAndTokenMocks(async (href, options = {}) => {
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice/1964?minorversion=65") {
      reads += 1;
      return jsonResponse({ Invoice: reads === 1 ? before : canonical });
    }
    if (href === "https://quickbooks.test/v3/company/realm-1/customer/42?minorversion=65") {
      return jsonResponse({ Customer: { Id: "42" } });
    }
    if (href.endsWith("/invoice?minorversion=65") && options.method === "POST") {
      updateBody = JSON.parse(options.body);
      return jsonResponse({ Invoice: { Id: "1964", SyncToken: "8" } });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const res = mockResponse();
  await updateInvoiceHandler(authenticatedRequest({
    invoice: {
      qbId: "1964",
      qbBaseContentFingerprint: fingerprintQuickBooksInvoiceContent(before),
      number: "1964",
      taxRate: "6",
      lineItems: [{
        qbLineId: "22",
        qbItemRef: { value: "8", name: "Services" },
        description: "Skimmer installation",
        qty: "1",
        unitPrice: "100",
        taxable: false,
      }],
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(updateBody.TxnTaxDetail, {
    TxnTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
    TotalTax: 0,
  });
  assert.deepEqual(updateBody.Line[0].SalesItemLineDetail.TaxCodeRef, { value: "NON" });
  assert.equal(res.body.invoice.taxAmount, 0);
  assert.equal(res.body.invoice.total, 100);
});

test("QuickBooks update faults never recreate an invoice that was just read successfully", async () => {
  const before = existingInvoice();
  let updateAttempts = 0;

  installAuthAndTokenMocks(async (href, options = {}) => {
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice/1964?minorversion=65") {
      return jsonResponse({ Invoice: before });
    }
    if (href === "https://quickbooks.test/v3/company/realm-1/customer/42?minorversion=65") {
      return jsonResponse({ Customer: { Id: "42" } });
    }
    if (href.endsWith("/invoice?minorversion=65") && options.method === "POST") {
      updateAttempts += 1;
      return jsonResponse({
        Fault: {
          Error: [{
            Message: "Object Not Found",
            Detail: "The item referenced by this line could not be found or is inactive.",
            code: "610",
          }],
        },
      }, 400);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const res = mockResponse();
  await updateInvoiceHandler(authenticatedRequest({
    invoice: {
      qbId: "1964",
      qbBaseContentFingerprint: fingerprintQuickBooksInvoiceContent(before),
      number: "1964",
      taxRate: "0",
      lineItems: [{
        qbLineId: "22",
        qbItemRef: { value: "8", name: "Services" },
        description: "Skimmer installation",
        qty: "1",
        unitPrice: "1417",
        taxable: false,
      }],
    },
  }), res);

  assert.equal(updateAttempts, 1);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, "QB_INVOICE_UPDATE_REJECTED");
  assert.equal(res.body.recreate, undefined);
  assert.match(res.body.error, /item referenced by this line/i);
});

test("QuickBooks create blocks taxable invoices when QuickBooks provides no real transaction tax code", async () => {
  const calls = [];
  installAuthAndTokenMocks(async (href, options = {}) => {
    calls.push({ href, method: options.method || "GET" });
    if (href === "https://quickbooks.test/v3/company/realm-1/customer/42?minorversion=65") {
      return jsonResponse({ Customer: { Id: "42", DisplayName: "Generic Client" } });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const res = mockResponse();
  await createInvoiceHandler(authenticatedRequest({
    invoice: {
      qbCustomerId: "42",
      number: "1965",
      clientName: "Generic Client",
      taxRate: "6",
      lineItems: [{
        qbItemRef: { value: "8", name: "Services" },
        description: "Taxable service",
        qty: "1",
        unitPrice: "100",
        taxable: true,
      }],
    },
  }), res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, "QB_TAX_CODE_REQUIRED");
  assert.equal(res.body.reviewRequired, true);
  assert.equal(res.body.expectedTax, 6);
  assert.equal(
    calls.some(({ href, method }) => href.endsWith("/invoice?minorversion=65") && method === "POST"),
    false,
  );
});

test("QuickBooks create uses the customer's real tax code and sends exact native TxnTaxDetail", async () => {
  let createBody = null;
  let createUrl = "";
  const canonical = {
    Id: "1966",
    SyncToken: "0",
    CustomerRef: { value: "42", name: "Generic Client" },
    DocNumber: "1966",
    TxnDate: "2026-07-27",
    TotalAmt: 106,
    Balance: 106,
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
      TotalTax: 6,
    },
    Line: [{
      Id: "1",
      LineNum: 1,
      Amount: 100,
      DetailType: "SalesItemLineDetail",
      Description: "Taxable service",
      SalesItemLineDetail: {
        ItemRef: { value: "8", name: "Services" },
        Qty: 1,
        UnitPrice: 100,
        TaxCodeRef: { value: "TAX" },
      },
    }],
  };

  installAuthAndTokenMocks(async (href, options = {}) => {
    if (href === "https://quickbooks.test/v3/company/realm-1/customer/42?minorversion=65") {
      return jsonResponse({
        Customer: {
          Id: "42",
          DisplayName: "Generic Client",
          DefaultTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
        },
      });
    }
    if (
      href.startsWith("https://quickbooks.test/v3/company/realm-1/invoice?minorversion=65&requestid=")
      && options.method === "POST"
    ) {
      createUrl = href;
      createBody = JSON.parse(options.body);
      return jsonResponse({ Invoice: { Id: "1966" } });
    }
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice/1966?minorversion=65") {
      return jsonResponse({ Invoice: canonical });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const res = mockResponse();
  await createInvoiceHandler(authenticatedRequest({
    invoice: {
      spsInvoiceId: "local-invoice-1966",
      qbCustomerId: "42",
      number: "1966",
      clientName: "Generic Client",
      date: "2026-07-27",
      taxRate: "6",
      lineItems: [{
        qbItemRef: { value: "8", name: "Services" },
        description: "Taxable service",
        qty: "1",
        unitPrice: "100",
        taxable: true,
      }],
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(createBody.Line[0].SalesItemLineDetail.TaxCodeRef, { value: "TAX" });
  assert.deepEqual(createBody.TxnTaxDetail, {
    TxnTaxCodeRef: { value: "PA-CODE", name: "PA Sales Tax" },
    TotalTax: 6,
  });
  assert.equal(res.body.qbContentFingerprint, fingerprintQuickBooksInvoiceContent(canonical));
  assert.match(createUrl, /[?&]requestid=sps-[a-f0-9]{40}$/);
  assert.equal(res.body.qbRequestId, new URL(createUrl).searchParams.get("requestid"));
  assert.equal(res.body.invoice.total, 106);
  assert.equal(res.body.invoice.taxAmount, 6);
  assert.equal(res.body.invoice.lineItems[0].qbLineId, "1");
});

test("QuickBooks create marks a thrown post-create outcome unknown and safely reuses its request id", async () => {
  const createUrls = [];
  let createAttempts = 0;
  const canonical = {
    Id: "1967",
    SyncToken: "0",
    CustomerRef: { value: "42", name: "Generic Client" },
    DocNumber: "1967",
    TxnDate: "2026-07-28",
    TotalAmt: 125,
    Balance: 125,
    Line: [{
      Id: "1",
      LineNum: 1,
      Amount: 125,
      DetailType: "SalesItemLineDetail",
      Description: "Pump service",
      SalesItemLineDetail: {
        ItemRef: { value: "8", name: "Services" },
        Qty: 1,
        UnitPrice: 125,
        TaxCodeRef: { value: "NON" },
      },
    }],
  };
  const request = authenticatedRequest({
    invoice: {
      spsInvoiceId: "local-invoice-1967",
      qbCustomerId: "42",
      number: "1967",
      clientName: "Generic Client",
      date: "2026-07-28",
      taxRate: 0,
      lineItems: [{
        qbItemRef: { value: "8", name: "Services" },
        description: "Pump service",
        qty: 1,
        unitPrice: 125,
        taxable: false,
      }],
    },
  });

  installAuthAndTokenMocks(async (href, options = {}) => {
    if (href === "https://quickbooks.test/v3/company/realm-1/customer/42?minorversion=65") {
      return jsonResponse({ Customer: { Id: "42", DisplayName: "Generic Client" } });
    }
    if (
      href.startsWith("https://quickbooks.test/v3/company/realm-1/invoice?minorversion=65&requestid=")
      && options.method === "POST"
    ) {
      createAttempts += 1;
      createUrls.push(href);
      if (createAttempts === 1) throw new Error("socket closed after upload");
      return jsonResponse({ Invoice: canonical });
    }
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice/1967?minorversion=65") {
      return jsonResponse({ Invoice: canonical });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const uncertain = mockResponse();
  await createInvoiceHandler(request, uncertain);

  assert.equal(uncertain.statusCode, 502);
  assert.equal(uncertain.body.createOutcomeUnknown, true);
  assert.match(uncertain.body.qbRequestId, /^sps-[a-f0-9]{40}$/);
  assert.match(uncertain.body.error, /may have created this invoice/i);
  assert.equal(
    uncertain.body.qbRequestId,
    new URL(createUrls[0]).searchParams.get("requestid"),
  );

  const recovered = mockResponse();
  await createInvoiceHandler(request, recovered);

  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body.success, true);
  assert.equal(recovered.body.qbId, "1967");
  assert.equal(recovered.body.qbRequestId, uncertain.body.qbRequestId);
  assert.equal(
    new URL(createUrls[1]).searchParams.get("requestid"),
    uncertain.body.qbRequestId,
  );
});

test("QuickBooks create keeps a known non-2xx rejection distinct from an unknown outcome", async () => {
  installAuthAndTokenMocks(async (href, options = {}) => {
    if (href === "https://quickbooks.test/v3/company/realm-1/customer/42?minorversion=65") {
      return jsonResponse({ Customer: { Id: "42", DisplayName: "Generic Client" } });
    }
    if (
      href.startsWith("https://quickbooks.test/v3/company/realm-1/invoice?minorversion=65&requestid=")
      && options.method === "POST"
    ) {
      return jsonResponse({
        Fault: {
          Error: [{
            Message: "Duplicate Document Number Error",
            Detail: "DocNumber=1963 is already in use",
          }],
        },
      }, 400);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const res = mockResponse();
  await createInvoiceHandler(authenticatedRequest({
    invoice: {
      spsInvoiceId: "local-invoice-1963",
      qbCustomerId: "42",
      number: "1963",
      clientName: "Generic Client",
      taxRate: 0,
      lineItems: [{
        qbItemRef: { value: "8", name: "Services" },
        description: "Service",
        qty: 1,
        unitPrice: 100,
        taxable: false,
      }],
    },
  }), res);

  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /QuickBooks rejected the invoice/i);
  assert.match(res.body.error, /Duplicate Document Number Error/i);
  assert.equal(Object.hasOwn(res.body, "createOutcomeUnknown"), false);
  assert.equal(Object.hasOwn(res.body, "qbRequestId"), false);
});
