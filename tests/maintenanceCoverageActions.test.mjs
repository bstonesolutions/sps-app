import assert from "node:assert/strict";
import test from "node:test";
import { maintenanceCoverageInvoiceChoices, maintenanceCoverageInvoicePreview, maintenanceCoverageSavedMessage } from "../maintenanceCoverageActions.js";

const client = { id: "a", name: "Maple Court", qbId: "qb-a" };
const other = { id: "b", name: "Birch Court", qbId: "qb-b" };

test("invoice choices respect saved client ownership before similar display names", () => {
  const own = { id: "own", clientId: client.id, clientName: other.name };
  const wrong = { id: "wrong", clientId: other.id, clientName: client.name };
  const qb = { id: "qb", qbCustomerId: client.qbId };
  const nameOnly = { id: "name", clientName: client.name };
  assert.deepEqual(maintenanceCoverageInvoiceChoices(client.id, [client, other], [own, wrong, qb, nameOnly]).map(invoice => invoice.id), ["own", "qb", "name"]);
  assert.deepEqual(maintenanceCoverageInvoiceChoices(client.id, [client, { ...other, name: client.name, qbId: client.qbId }], [qb, nameOnly]), []);
});

test("invoice match preview distinguishes open, partial and paid canonical balances", () => {
  for (const [invoice, expected] of [
    [{ status: "Draft", total: 175 }, "Invoice open"],
    [{ status: "Paid", total: 175, balance: 175 }, "Invoice open"],
    [{ status: "Sent", total: 175, balance: 75 }, "Partly paid"],
    [{ status: "Sent", total: 175, balance: 0 }, "Paid"],
  ]) {
    const preview = maintenanceCoverageInvoicePreview(invoice, ["2026-10"]);
    assert.equal(preview.label, expected);
    assert.equal(preview.totalCents, 17500);
    assert.equal(preview.monthCount, 1);
  }
  assert.equal(maintenanceCoverageInvoicePreview({ lineItems: [{ qty: 1, unitPrice: 175 }], status: "Draft" }).totalCents, 17500);
  assert.equal(maintenanceCoverageInvoicePreview({ lineItems: [{ qty: 1 }], status: "Draft" }).totalCents, null);
  assert.equal(maintenanceCoverageInvoicePreview({ qbId: "qb-1", lineItems: [{ qty: 1, unitPrice: 175 }], status: "Paid" }).totalCents, null);
});

test("save receipt reports the returned ledger instead of assuming invoice linking means paid", () => {
  const ledger = { allocations: { a: {
    "2026-10": { status: "due", sources: [{ kind: "invoice", invoiceId: "open" }] },
    "2026-11": { status: "paid", sources: [{ kind: "manual", decision: "paid" }] },
    "2026-12": { status: "due", sources: [{ kind: "manual", decision: "unpaid" }] },
  } } };
  assert.equal(maintenanceCoverageSavedMessage(ledger, "a", ["2026-10"]), "Saved. Oct 2026: Invoice open.");
  assert.equal(maintenanceCoverageSavedMessage(ledger, "a", ["2026-11", "2026-12"]), "Saved. Nov 2026: Paid, recorded by you; Dec 2026: Unpaid.");
});
