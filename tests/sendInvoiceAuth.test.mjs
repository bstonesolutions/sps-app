import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.API_AUTH_ENFORCED = "true";

const { default: sendInvoiceHandler } = await import("../api/send-invoice.js");
const { memberHasCapability } = await import("../api/_staff-auth.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, ok = true, status = 200) => ({
  ok,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
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

const request = () => ({
  method: "POST",
  headers: { authorization: "Bearer staff-token" },
  body: {
    to: "client@example.com",
    clientName: "Generic Client",
    branding: { companyName: "Stone Property Solutions", accent: "#AF011A" },
    invoice: {
      number: "2048",
      date: "08/19/2026",
      dueDate: "09/03/2026",
      lineItems: [{ desc: "Service", qty: 1, unitPrice: 175, taxable: false }],
      subtotal: 175,
      tax: 0,
      total: 175,
    },
  },
});

test("invoiceSend requires invoice edit access and respects the fine-grained switch", () => {
  assert.equal(memberHasCapability({ role: "field", tabAccess: { invoices: "view" } }, "invoiceSend"), false);
  assert.equal(memberHasCapability({ role: "custom", tabAccess: { invoices: "edit" }, fine: { invoiceSend: false } }, "invoiceSend"), false);
  assert.equal(memberHasCapability({ role: "custom", tabAccess: { invoices: "edit" }, fine: { invoiceSend: true } }, "invoiceSend"), true);
  assert.equal(memberHasCapability({ role: "owner", tabAccess: { invoices: "hidden" } }, "invoiceSend"), true);
});

for (const [label, team] of [
  ["a signed-in client portal user", []],
  ["invoice read-only staff", [{ email: "staff@example.com", role: "field", tabAccess: { invoices: "view" } }]],
  ["staff whose invoice-send switch is off", [{ email: "staff@example.com", role: "custom", tabAccess: { invoices: "edit" }, fine: { invoiceSend: false } }]],
]) {
  test(`send-invoice rejects ${label} before contacting Resend`, async () => {
    let resendCalls = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("/auth/v1/user")) {
        return response({ id: "auth-1", email: "staff@example.com" });
      }
      if (href.includes("key=eq.sps_team")) {
        return response([{ value: JSON.stringify(team) }]);
      }
      if (href === "https://api.resend.com/emails") {
        resendCalls += 1;
        return response({ id: "should-not-send" });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const res = mockResponse();
    await sendInvoiceHandler(request(), res);

    assert.equal(res.statusCode, 403);
    assert.equal(resendCalls, 0);
  });
}

test("authorized invoice staff can send only after the protected team lookup", async () => {
  const calls = [];
  const team = [{
    email: "staff@example.com",
    role: "custom",
    tabAccess: { invoices: "edit" },
    fine: { invoiceSend: true },
  }];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/auth/v1/user")) {
      return response({ id: "auth-1", email: "staff@example.com" });
    }
    if (href.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify(team) }]);
    }
    if (href === "https://api.resend.com/emails") {
      return response({ id: "email-2048" });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await sendInvoiceHandler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { sent: true, id: "email-2048" });
  assert.equal(calls.filter((href) => href.includes("key=eq.sps_team")).length, 1);
  assert.equal(calls.filter((href) => href === "https://api.resend.com/emails").length, 1);
});
