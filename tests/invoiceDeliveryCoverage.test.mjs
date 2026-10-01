import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { assertInvoiceDeliveryCoverage, invoiceDeliveryIdentity, invoiceDeliveryLine } from "../invoiceDeliveryCoverage.js";
import { deliverSelectedInvoices } from "../invoiceBulkDelivery.js";
import { invoiceServiceLineMonths } from "../invoiceServiceDescription.js";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.API_AUTH_ENFORCED = "true";
const { default: sendInvoice } = await import("../api/send-invoice.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const client = { id: "client-a", name: "Demo Client", email: "client@example.test", monthlyRate: "175", history: [] };
const line = { id: "line-a", desc: "Monthly maintenance", serviceMonth: "2026-10", kind: "service", qty: 1, unitPrice: 175, taxable: false };
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

test("delivery round trips preserve each line's actual service dates and maintenance classification", () => {
  const invoice = { ...draft, serviceMonth: "2026-12", date: "12/01/2026", lineItems: [
    { ...line, sourceStopId: "october-visit" },
    { ...line, id: "november", serviceMonth: undefined, serviceDate: "11/15/2026", sourceCompletionReceiptId: "november-receipt" },
    { ...line, id: "visits", desc: "Services", serviceMonth: undefined, maintenanceService: true, sourceVisitDates: ["2026-09-15", "2026-10-15"] },
  ] };
  const serialized = JSON.parse(JSON.stringify({ ...invoiceDeliveryIdentity(invoice, client.id), lineItems: invoice.lineItems.map(invoiceDeliveryLine) }));
  assert.equal(serialized.serviceMonth, "2026-12");
  assert.equal(serialized.lineItems[0].sourceStopId, "october-visit");
  assert.equal(serialized.lineItems[1].sourceCompletionReceiptId, "november-receipt");
  assert.equal(serialized.lineItems[2].maintenanceService, true);
  assert.deepEqual(serialized.lineItems.map(item => invoiceServiceLineMonths(serialized, item)), [["2026-10"], ["2026-11"], ["2026-09", "2026-10"]]);
});

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const res = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
function mockEmailState({ billing = ledger, invoices = [source, draft] } = {}) {
  const sends = [];
  globalThis.fetch = async (url, settings = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "staff", email: "staff@example.test" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ id: "staff", email: "staff@example.test", role: "custom", tabAccess: { invoices: "edit" }, fine: { invoiceSend: true } }]) }]);
    if (href.includes("/rest/v1/app_state?")) return response(Object.entries({ sps_clients: [client], sps_invoices: invoices, sps_maintenance_billing: billing, sps_schedule: [] }).map(([key, value]) => ({ key, value: JSON.stringify(value), version: 1 })));
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

test("new email invoices retain explicit line month and date evidence without canonical recovery", async () => {
  for (const dateEvidence of [{ serviceMonth: "2026-11" }, { serviceDate: "2026-11-15" }, { sourceVisitDates: ["2026-11-15"] }]) {
    const invoice = { ...draft, id: "new-email", date: "12/01/2026", lineItems: [{ ...line, serviceMonth: undefined, ...dateEvidence }] };
    const sends = mockEmailState({ invoices: [], billing: { version: 2, policies: {}, allocations: {} } });
    const result = res();
    await sendInvoice(emailRequest(invoice), result);
    assert.equal(result.statusCode, 200, JSON.stringify({ dateEvidence, body: result.body }));
    assert.equal(sends.length, 1);
  }
});

test("new email invoices still block covered service and reject issue-date-only evidence", async () => {
  const covered = { ...draft, id: "new-email", date: "12/01/2026" };
  let sends = mockEmailState({ invoices: [source] });
  let result = res();
  await sendInvoice(emailRequest(covered), result);
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(sends.length, 0);

  const missing = { ...covered, lineItems: [{ ...line, serviceMonth: undefined }] };
  sends = mockEmailState({ invoices: [], billing: { version: 2, policies: {}, allocations: {} } });
  result = res();
  await sendInvoice(emailRequest(missing), result);
  assert.equal(result.body.code, "maintenance-service-month-missing");
  assert.equal(sends.length, 0);
});

test("changing an original payment amount or linked service month does not borrow its delivery exemption", async () => {
  for (const changedLine of [
    { ...line, unitPrice: 350 },
    { ...line, serviceMonth: "2026-11" },
  ]) {
    const invoice = { ...source, sourceStopId: "protected-visit", lineItems: [changedLine] };
    const saved = { ...source, sourceStopId: "protected-visit" };
    const sends = mockEmailState({ invoices: [saved, draft] });
    const result = res();
    await sendInvoice(emailRequest(invoice), result);
    assert.equal(result.statusCode, 409, JSON.stringify(result.body));
    assert.equal(sends.length, 0);
  }
});

test("delivery cannot remove a canonical maintenance marker to bypass payment coverage", async () => {
  const saved = { ...draft, lineItems: [{ ...line, desc: "Services - October 2026", maintenanceService: true }] };
  const invoice = { ...saved, lineItems: [{ ...saved.lineItems[0], maintenanceService: false }] };
  const sends = mockEmailState({ invoices: [source, saved] });
  const result = res();
  await sendInvoice(emailRequest(invoice), result);
  assert.equal(result.statusCode, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, "maintenance-already-covered");
  assert.equal(sends.length, 0);
});
