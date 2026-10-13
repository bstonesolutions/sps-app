import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.QB_API_BASE = "https://quickbooks.test";
process.env.API_AUTH_ENFORCED = "true";
const { createBillingReviewHandler } = await import("../api/billing-review.js");
const { makeBillingReview } = await import("../billingReview.js");
const { buildQuickBooksInvoicePayload } = await import("../quickbooksDraftSync.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const copy = value => structuredClone(value);
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => copy(body), text: async () => JSON.stringify(body) });
const capture = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });

function harness({ retainedApproval = false, role = "owner", rejectAuthAfter = Infinity } = {}) {
  const client = { id: "client-1", name: "Example Client", qbId: "customer-1", history: [] };
  const config = { nextNumber: 1001, numberPrefix: "", qbManagePayments: true };
  const review = makeBillingReview({
    id: "review-1", clientId: client.id, clientName: client.name, date: "10/13/2026", dueDate: "10/28/2026", taxRate: "0",
    lineItems: [{ id: "line-1", desc: "Pond netting materials", kind: "product", qty: "1", unitPrice: "250", taxable: false, qbItemRef: { value: "item-1" } }],
  }, { now: "2026-10-13T12:00:00Z" });
  if (retainedApproval) {
    const invoice = { ...copy(review), number: "1060", status: "Draft", billingReviewId: review.id };
    const requestKey = "review-1:approval:original-attempt";
    review.reviewState = "approving";
    review.approval = {
      attemptId: "original-attempt", requestKey, number: "1060", invoice,
      payload: { ...buildQuickBooksInvoicePayload(invoice, client, config), qbCreateRequestKey: requestKey },
      realmId: "realm-1", state: "unknown", startedAt: "2026-10-13T11:00:00Z", leaseUntil: null,
      error: "Cannot read properties of undefined (reading 'authorization')",
    };
    review.numberClaims = ["1060"];
  }
  const values = {
    sps_billing_reviews: [review], sps_invoices: [], sps_estimates: [], sps_schedule: [],
    sps_clients: [client], sps_completed: {}, sps_invoicing: config,
    sps_maintenance_billing: { version: 2, policies: {}, allocations: {} },
  };
  const rows = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { key, exists: true, version: 1, value: copy(value) }]));
  const calls = { auth: [], requests: [], reads: 0, inventories: 0, attempts: 0 };
  let savedQuickBooksInvoice;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.requests.push({ url: String(url), method: options.method || "GET", body: options.body });
    if (parsed.origin === "https://supabase.test" && parsed.pathname === "/auth/v1/user") {
      calls.auth.push(options.headers.Authorization);
      assert.equal(options.headers.Authorization, "Bearer owner-token");
      return calls.auth.length > rejectAuthAfter ? response({ error: "revoked" }, 401) : response({ id: "owner-user", email: "owner@example.test" });
    }
    if (parsed.origin === "https://supabase.test" && parsed.pathname === "/rest/v1/app_state" && parsed.searchParams.get("key") === "eq.sps_team") {
      return response([{ value: JSON.stringify([{ id: "team-1", email: "owner@example.test", role, active: true }]) }]);
    }
    if (parsed.origin === "https://supabase.test" && parsed.pathname === "/rest/v1/qb_tokens") {
      return response([{ realm_id: "realm-1", access_token: "synthetic-qb-token", expires_at: "2099-01-01T00:00:00Z" }]);
    }
    if (parsed.origin === "https://quickbooks.test" && parsed.pathname === "/v3/company/realm-1/customer/customer-1") {
      return response({ Customer: { Id: "customer-1", DisplayName: client.name } });
    }
    if (parsed.origin === "https://quickbooks.test" && parsed.pathname === "/v3/company/realm-1/invoice" && options.method === "POST") {
      assert.ok(parsed.searchParams.get("requestid"));
      savedQuickBooksInvoice = { ...JSON.parse(options.body), Id: "qb-1", TotalAmt: 250, Balance: 250 };
      return response({ Invoice: savedQuickBooksInvoice });
    }
    if (parsed.origin === "https://quickbooks.test" && parsed.pathname === "/v3/company/realm-1/invoice/qb-1" && !options.method) {
      return response({ Invoice: savedQuickBooksInvoice });
    }
    throw new Error(`Unexpected test request: ${options.method || "GET"} ${parsed.origin}${parsed.pathname}`);
  };
  const apply = async operations => {
    if (operations.some(op => rows[op.key]?.version !== op.expectedVersion)) return { applied: false };
    for (const op of operations) if (!op.checkOnly) rows[op.key] = { ...rows[op.key], value: copy(op.value), version: rows[op.key].version + 1 };
    return { applied: true, currentVersions: Object.fromEntries(operations.map(op => [op.key, rows[op.key].version])) };
  };
  // Authorization and createInvoice are deliberately the actual handlers. Only state storage
  // and external HTTP are local fixtures, so the Node request's inherited headers cross both gates.
  const handler = createBillingReviewHandler({
    read: async keys => { calls.reads += 1; return Object.fromEntries(keys.map(key => [key, copy(rows[key])])); },
    cas: (key, expectedVersion, value) => apply([{ key, expectedVersion, value }]), batch: apply,
    inventory: async () => { calls.inventories += 1; return { realmId: "realm-1", numbers: [], checkedAt: "2026-10-13T12:00:00Z" }; },
    now: () => Date.parse("2026-10-13T12:00:00Z"), uuid: () => { calls.attempts += 1; return "new-attempt"; },
  });
  return {
    calls, rows,
    async call(body, token = "owner-token") {
      const req = new IncomingMessage(new Socket());
      req.method = "POST";
      req.url = "/api/billing-review";
      req.headers = token ? { authorization: `Bearer ${token}` } : {};
      req.body = body;
      assert.equal(Object.hasOwn(req, "headers"), false, "fixture must use the real inherited IncomingMessage header accessor");
      assert.equal({ ...req }.headers, undefined, "spreading this request must reproduce the production header loss");
      const res = capture();
      try { await handler(req, res); } finally { req.socket.destroy(); }
      assert.equal(req.body, body, "the forwarding call must not replace the incoming request body");
      return res;
    },
  };
}

test("real IncomingMessage headers survive owner confirmation and actual QuickBooks authentication", async () => {
  const h = harness();
  const result = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(result.body.invoice.qbId, "qb-1");
  assert.equal(result.body.review.reviewState, "synced");
  assert.deepEqual(h.calls.auth, ["Bearer owner-token", "Bearer owner-token"]);
  assert.equal(h.rows.sps_invoices.value.length, 1);
  assert.equal(h.calls.requests.filter(call => call.method === "POST").length, 1);
  assert.ok(h.calls.requests.every(call => !/\/send(?:\?|$)|email/i.test(call.url)));
});

test("retry recovers an approval stranded before QB creation using its original number and request key", async () => {
  const h = harness({ retainedApproval: true });
  const result = await h.call({ action: "retry", reviewId: "review-1" });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(result.body.invoice.number, "1060");
  assert.equal(result.body.review.approval.attemptId, "original-attempt");
  assert.equal(result.body.review.approval.requestKey, "review-1:approval:original-attempt");
  assert.equal(h.calls.inventories, 0);
  assert.equal(h.calls.attempts, 0);
  assert.equal(h.rows.sps_invoices.value.length, 1);
  const again = await h.call({ action: "retry", reviewId: "review-1" });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.invoice.qbId, "qb-1");
  assert.equal(h.calls.requests.filter(call => call.method === "POST").length, 1);
  assert.equal(h.rows.sps_invoices.value.length, 1);
});

test("missing authentication and non-owner callers cannot reach billing records or QuickBooks", async () => {
  for (const scenario of [{ token: null, role: "owner", status: 401 }, { token: "owner-token", role: "field", status: 403 }]) {
    const h = harness({ role: scenario.role });
    const result = await h.call({ action: "retry", reviewId: "review-1" }, scenario.token);
    assert.equal(result.statusCode, scenario.status);
    assert.equal(h.calls.reads, 0);
    assert.equal(h.calls.requests.filter(call => call.url.startsWith("https://quickbooks.test")).length, 0);
  }
});

test("forwarding headers does not bypass the QuickBooks handler's own revoked-token check", async () => {
  const h = harness({ rejectAuthAfter: 1 });
  const result = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(result.statusCode, 422);
  assert.equal(result.body.review.reviewState, "pending");
  assert.deepEqual(h.calls.auth, ["Bearer owner-token", "Bearer owner-token"]);
  assert.equal(h.calls.requests.filter(call => call.url.startsWith("https://quickbooks.test")).length, 0);
  assert.equal(h.rows.sps_invoices.value.length, 0);
});
