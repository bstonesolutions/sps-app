import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  fingerprintQuickBooksInvoiceContent,
  fingerprintQuickBooksInvoiceSnapshot,
  normalizeQuickBooksInvoiceContent,
  quickBooksInvoiceCreateRequestId,
} from "../api/quickbooks/invoice-revision.js";

const baseInvoice = () => ({
  Id: "1964",
  SyncToken: "7",
  MetaData: { LastUpdatedTime: "2026-07-27T10:00:00-04:00" },
  CustomerRef: { value: "42", name: "Generic Client" },
  DocNumber: "1964",
  TxnDate: "2026-07-27",
  DueDate: "2026-08-11",
  TotalAmt: 100,
  Balance: 100,
  EmailStatus: "NeedToSend",
  Line: [{
    Id: "1",
    LineNum: 1,
    Amount: 100,
    DetailType: "SalesItemLineDetail",
    Description: "Maintenance",
    SalesItemLineDetail: {
      ItemRef: { value: "8", name: "Services" },
      Qty: 1,
      UnitPrice: 100,
      TaxCodeRef: { value: "NON" },
    },
  }],
});

test("invoice content fingerprint ignores payment, delivery, and revision metadata", () => {
  const before = baseInvoice();
  const after = {
    ...baseInvoice(),
    SyncToken: "11",
    MetaData: { LastUpdatedTime: "2026-07-27T12:00:00-04:00" },
    Balance: 25,
    EmailStatus: "EmailSent",
    DeliveryInfo: { DeliveryTime: "2026-07-27T12:00:00-04:00" },
    LinkedTxn: [{ TxnId: "payment-1", TxnType: "Payment" }],
  };

  assert.equal(
    fingerprintQuickBooksInvoiceContent(before),
    fingerprintQuickBooksInvoiceContent(after),
  );
});

test("invoice content fingerprint detects a QuickBooks-only line addition", () => {
  const before = baseInvoice();
  const after = baseInvoice();
  after.Line.push({
    Id: "2",
    LineNum: 2,
    Amount: 6,
    DetailType: "SalesItemLineDetail",
    Description: "QuickBooks-only service",
    SalesItemLineDetail: {
      ItemRef: { value: "19", name: "Sales Tax" },
      Qty: 1,
      UnitPrice: 6,
    },
  });

  assert.notEqual(
    fingerprintQuickBooksInvoiceContent(before),
    fingerprintQuickBooksInvoiceContent(after),
  );
});

test("a normalized base snapshot produces the same fingerprint as its source invoice", () => {
  const invoice = baseInvoice();
  const snapshot = normalizeQuickBooksInvoiceContent(invoice);
  assert.equal(
    fingerprintQuickBooksInvoiceSnapshot(snapshot),
    fingerprintQuickBooksInvoiceContent(invoice),
  );
  assert.equal("SyncToken" in snapshot, false);
  assert.equal("Balance" in snapshot, false);
});

test("a recreation generation has a stable request id distinct from the original create", () => {
  const original = quickBooksInvoiceCreateRequestId("realm-1", "local-invoice-1964");
  const recreate = quickBooksInvoiceCreateRequestId(
    "realm-1",
    "local-invoice-1964:recreate:deleted-qb-4949",
  );

  assert.match(original, /^sps-[a-f0-9]{40}$/);
  assert.equal(
    quickBooksInvoiceCreateRequestId("realm-1", "local-invoice-1964:recreate:deleted-qb-4949"),
    recreate,
  );
  assert.notEqual(recreate, original);
});

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.API_AUTH_ENFORCED = "true";
process.env.QB_API_BASE = "https://quickbooks.test";

const { default: updateInvoiceHandler } = await import("../api/quickbooks/update-invoice.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
  async text() { return JSON.stringify(body); },
});

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

test("update endpoint returns review-required 409 before writing when QuickBooks gained a line", async () => {
  const synced = baseInvoice();
  const changed = baseInvoice();
  changed.SyncToken = "8";
  changed.Line = [...changed.Line, {
    Id: "2",
    LineNum: 2,
    Amount: 25,
    DetailType: "SalesItemLineDetail",
    Description: "Added in QuickBooks",
    SalesItemLineDetail: {
      ItemRef: { value: "10", name: "Services" },
      Qty: 1,
      UnitPrice: 25,
    },
  }];
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || "GET" });
    if (href.includes("/auth/v1/user")) {
      return jsonResponse({ id: "owner-1", email: "owner@example.com" });
    }
    if (href.includes("/rest/v1/qb_tokens")) {
      return jsonResponse([{
        id: "default",
        realm_id: "realm-1",
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: "2099-01-01T00:00:00.000Z",
      }]);
    }
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice/1964?minorversion=65") {
      return jsonResponse({ Invoice: changed });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const req = {
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
    body: {
      invoice: {
        qbId: "1964",
        qbBaseContentFingerprint: fingerprintQuickBooksInvoiceContent(synced),
        number: "1964",
        lineItems: [{ description: "Maintenance", qty: "1", unitPrice: "100" }],
      },
    },
  };
  const res = mockResponse();
  await updateInvoiceHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "quickbooks_invoice_changed");
  assert.equal(res.body.reviewRequired, true);
  assert.equal(res.body.currentInvoice.Line.length, 2);
  assert.equal(calls.some((call) => call.method === "POST" && call.href.includes("/v3/company/")), false);
  assert.equal(calls.some((call) => call.href.includes("/query?")), false);
});

test("update endpoint requires a synced base before it can replace invoice lines", async () => {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return jsonResponse({ id: "owner-1" });
    if (href.includes("/rest/v1/qb_tokens")) {
      return jsonResponse([{
        realm_id: "realm-1",
        access_token: "access-token",
        expires_at: "2099-01-01T00:00:00.000Z",
      }]);
    }
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice/1964?minorversion=65") {
      return jsonResponse({ Invoice: baseInvoice() });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await updateInvoiceHandler({
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
    body: { invoice: { qbId: "1964", lineItems: [] } },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "quickbooks_invoice_sync_required");
  assert.equal(res.body.reviewRequired, true);
});

test("update endpoint proceeds when the current QuickBooks content still matches the synced base", async () => {
  const existing = baseInvoice();
  let updateBody = null;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return jsonResponse({ id: "owner-1" });
    if (href.includes("/rest/v1/qb_tokens")) {
      return jsonResponse([{
        realm_id: "realm-1",
        access_token: "access-token",
        expires_at: "2099-01-01T00:00:00.000Z",
      }]);
    }
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice/1964?minorversion=65") {
      return jsonResponse({ Invoice: existing });
    }
    if (href.includes("/query?") && href.includes("Item")) {
      return jsonResponse({ QueryResponse: { Item: [{ Id: "8", Name: "Services" }] } });
    }
    if (href === "https://quickbooks.test/v3/company/realm-1/invoice?minorversion=65" && options.method === "POST") {
      updateBody = JSON.parse(options.body);
      return jsonResponse({ Invoice: { Id: "1964", InvoiceLink: "https://pay.example/1964" } });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await updateInvoiceHandler({
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
    body: {
      invoice: {
        qbId: "1964",
        qbBaseSnapshot: normalizeQuickBooksInvoiceContent(existing),
        number: "1964",
        date: "2026-07-27",
        dueDate: "2026-08-11",
        lineItems: [{
          description: "Updated maintenance",
          kind: "service",
          qty: "1",
          unitPrice: "125",
          taxable: false,
        }],
      },
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(updateBody.SyncToken, "7");
  assert.equal(updateBody.Line[0].Description, "Updated maintenance");
  assert.equal(updateBody.Line[0].Amount, 125);
});
