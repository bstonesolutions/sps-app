import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { assertInvoiceDeliveryCoverage, invoiceDeliveryIdentity, invoiceDeliveryLine } from "../invoiceDeliveryCoverage.js";
import { deliverSelectedInvoices } from "../invoiceBulkDelivery.js";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.API_AUTH_ENFORCED = "true";
const { default: sendInvoice } = await import("../api/send-invoice.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const client = { id: "client-a", name: "Demo Client", email: "client@example.test", monthlyRate: "175", history: [] };
const line = { id: "line-a", desc: "Monthly maintenance", kind: "service", qty: 1, unitPrice: 175, taxable: false };
const source = { id: "source", clientId: client.id, number: "INV-1", date: "10/01/2026", dueDate: "10/15/2026", status: "Paid", total: 175, balance: 0, lineItems: [line] };
const draft = { ...source, id: "draft", number: "INV-2", status: "Draft", balance: 175 };
const ledger = { version: 2, policies: {}, allocations: { [client.id]: { "2026-10": { status: "paid", expectedCents: 17500, allocatedCents: 17500, sources: [{ kind: "invoice", invoiceId: source.id, amountCents: 17500 }] } } } };
const options = { client, clients: [client], invoices: [source, draft], schedule: [] };

test("fresh coverage checks prevent all channels and status changes for a covered invoice", async () => {
  const calls = [];
  const results = await deliverSelectedInvoices({
    invoices: [draft],
    buildChannels: async invoice => {
      await assertInvoiceDeliveryCoverage({ ...options, invoice, loadLedger: async () => { calls.push("coverage"); return ledger; } });
      return ["sms", "email", "portal"].map(id => ({ id, enabled: true, send: async () => { calls.push(id); return { ok: true }; } }));
    },
    onAccepted: async () => calls.push("mark-sent"),
  });
  assert.deepEqual(calls, ["coverage"]);
  assert.equal(results[0].accepted, false);
  assert.match(results[0].failed[0].error, /already covered/);
});

test("an unavailable ledger holds maintenance while unrelated repair invoices can still be delivered", async () => {
  const sent = [];
  const repair = { ...draft, id: "repair", lineItems: [{ ...line, desc: "Pump repair labor" }] };
  const results = await deliverSelectedInvoices({
    invoices: [draft, repair],
    buildChannels: async invoice => {
      await assertInvoiceDeliveryCoverage({ ...options, invoice, loadLedger: async () => { throw new Error("offline"); } });
      return [{ id: "email", enabled: true, send: async () => { sent.push(invoice.id); return { ok: true }; } }];
    },
  });
  assert.deepEqual(sent, ["repair"]);
  assert.equal(results[0].accepted, false);
  assert.equal(results[1].accepted, true);
});

test("email metadata retains billing identities without exposing internal cost fields", () => {
  assert.equal(invoiceDeliveryIdentity(draft, client.id).spsInvoiceId, draft.id);
  assert.deepEqual(invoiceDeliveryLine({ ...line, unitCost: 50, costKnown: true }), line);
});

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const res = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
function mockEmailState({ billing = ledger } = {}) {
  const sends = [];
  globalThis.fetch = async (url, settings = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "staff", email: "staff@example.test" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ id: "staff", email: "staff@example.test", role: "custom", tabAccess: { invoices: "edit" }, fine: { invoiceSend: true } }]) }]);
    if (href.includes("/rest/v1/app_state?")) return response(Object.entries({ sps_clients: [client], sps_invoices: [source, draft], sps_maintenance_billing: billing, sps_schedule: [] }).map(([key, value]) => ({ key, value: JSON.stringify(value), version: 1 })));
    if (href === "https://api.resend.com/emails") { sends.push(settings.body); return response({ id: "test-message" }); }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  return sends;
}
const emailRequest = invoice => ({ method: "POST", headers: { authorization: "Bearer staff-token" }, body: { to: client.email, clientName: client.name, invoice: { ...invoiceDeliveryIdentity(invoice, client.id), number: invoice.number, date: invoice.date, dueDate: invoice.dueDate, lineItems: invoice.lineItems.map(invoiceDeliveryLine), total: invoice.total, subtotal: invoice.total, tax: 0, taxRate: 0 }, branding: { companyName: "Demo" } } });

test("email endpoint refuses a covered existing draft before contacting the provider", async () => {
  const sends = mockEmailState();
  const result = res();
  await sendInvoice(emailRequest(draft), result);
  assert.equal(result.statusCode, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(result.body.sent, false);
  assert.equal(sends.length, 0);
});

test("email endpoint permits unchanged original payment evidence and separate repair labor", async () => {
  for (const invoice of [source, { ...draft, lineItems: [{ ...line, desc: "Pump repair labor" }] }]) {
    const sends = mockEmailState();
    const result = res();
    await sendInvoice(emailRequest(invoice), result);
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(sends.length, 1);
  }
});

test("email endpoint holds malformed coverage before delivery", async () => {
  const sends = mockEmailState({ billing: { version: 2, policies: {}, allocations: null } });
  const result = res();
  await sendInvoice(emailRequest(draft), result);
  assert.equal(result.statusCode, 503, JSON.stringify(result.body));
  assert.equal(sends.length, 0);
});
