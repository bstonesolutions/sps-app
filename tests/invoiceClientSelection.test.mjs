import assert from "node:assert/strict";
import test from "node:test";
import { initialInvoiceClientId, invoiceClientChoices, invoiceClientSnapshot, resolveInvoiceClient } from "../invoiceClientSelection.js";

const clients = [
  { id: "past", name: "Past Client", status: "Inactive", address: "12 Birch Lane", email: "past@example.test" },
  { id: 42, name: "Maple Court", status: "Active", address: "8 Maple Road", email: "maple@example.test" },
];

test("new invoices remain unselected regardless of client ordering or later loading", () => {
  assert.equal(initialInvoiceClientId(clients), null);
  assert.equal(initialInvoiceClientId([...clients].reverse()), null);
  const invoice = { clientId: initialInvoiceClientId([]), number: "INV-1" };
  assert.equal(invoiceClientSnapshot(invoice, clients), null);
});

test("a deliberate preset resolves to the actual client ID, including inactive clients and zero", () => {
  assert.equal(initialInvoiceClientId(clients, "42"), 42);
  assert.equal(initialInvoiceClientId(clients, "past"), "past");
  assert.equal(initialInvoiceClientId(clients, "missing"), null);
  assert.equal(initialInvoiceClientId([{ id: 0, name: "Zero ID" }], "0"), 0);
});

test("invoice choices include inactive clients and search by name, address, or email", () => {
  assert.deepEqual(invoiceClientChoices(clients).map(client => client.id), [42, "past"]);
  assert.deepEqual(invoiceClientChoices(clients, "past BIRCH").map(client => client.id), ["past"]);
  assert.deepEqual(invoiceClientChoices(clients, "maple@example.test").map(client => client.id), [42]);
  assert.deepEqual(invoiceClientChoices(clients, "absent"), []);
  assert.equal(clients[0].id, "past", "sorting must not reorder shared clients");
});

test("saving snapshots exactly the selected client, including a selected inactive client", () => {
  const invoice = { id: "draft", clientId: "42", clientName: "Old name", lineItems: [{ id: "line" }] };
  const saved = invoiceClientSnapshot(invoice, clients);
  assert.equal(saved.clientId, 42);
  assert.equal(saved.clientName, "Maple Court");
  assert.equal(saved.clientAddress, "8 Maple Road");
  assert.equal(saved.clientEmail, "maple@example.test");
  assert.deepEqual(saved.lineItems, invoice.lineItems);
  assert.equal(invoice.clientName, "Old name");
  assert.equal(invoiceClientSnapshot({ clientId: "past" }, [clients[0]]).clientName, "Past Client");
});

test("missing, malformed, or ambiguous client IDs cannot create a save candidate", () => {
  for (const clientId of [undefined, null, "", " ", "missing", {}, [], NaN, Infinity]) {
    assert.equal(resolveInvoiceClient(clients, clientId), null);
    assert.equal(invoiceClientSnapshot({ clientId, clientName: "Maple Court" }, clients), null);
  }
  const ambiguous = [{ id: 42, name: "First" }, { id: "42", name: "Second" }];
  assert.equal(resolveInvoiceClient(ambiguous, "42"), null);
  assert.deepEqual(invoiceClientChoices(ambiguous), []);
  assert.deepEqual(invoiceClientChoices([null, { id: {}, name: "Bad" }, { id: "blank", name: " " }]), []);
});

test("removing a client while an invoice is open invalidates its save candidate without retargeting", () => {
  const invoice = { clientId: 42, clientName: "Maple Court" };
  assert.equal(invoiceClientSnapshot(invoice, [clients[0]]), null);
  assert.equal(invoice.clientId, 42);
  assert.equal(invoiceClientSnapshot(invoice, clients).clientId, 42);
});
