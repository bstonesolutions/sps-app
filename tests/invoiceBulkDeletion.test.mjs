import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { deleteSelectedInvoiceDrafts, invoiceBulkDeleteEligibility, invoiceDeletionReviewMatches, partitionInvoiceBulkDeletion } from "../invoiceBulkDeletion.js";
import { emptyMaintenancePaymentLedger, normalizeMaintenancePaymentLedger } from "../maintenancePaymentLedger.js";
import { findInvoiceDeletionReferences, invoiceDeletionBlockedMessage } from "../invoiceDeletionGuard.js";
import { deleteInvoiceAndCompactSafeDrafts } from "../invoiceNumbering.js";

const draft = (id = "draft-1", extra = {}) => ({ id, number: `INV-${id.slice(-1)}`, status: "Draft", clientId: "sample-client", total: 100, lineItems: [{ desc: "Service", qty: 1, unitPrice: 100 }], ...extra });
const context = () => ({ ledger: emptyMaintenancePaymentLedger() });

test("only selected drafts are included and duplicate identifiers fail closed", () => {
  const first = draft();
  const second = draft("draft-2");
  const plan = partitionInvoiceBulkDeletion([first, second, { ...second }], [first.id, second.id, "missing"], context());
  assert.deepEqual(plan.ready.map((row) => row.invoice.id), [first.id]);
  assert.deepEqual(plan.skipped.map((row) => row.code), ["ambiguous-id", "missing"]);
  assert.equal(partitionInvoiceBulkDeletion([first, second], [first.id], context()).rows.length, 1);
});

test("QuickBooks, sent, paid, shared, and partially paid records cannot be bulk deleted", () => {
  for (const evidence of [
    { status: "Paid" }, { status: "Sent" }, { status: "Void" },
    { qbId: "qb-1", qbSpsOnly: true }, { qbSyncStatus: "pending", qbSpsOnly: true },
    { qbAuthoritative: true }, { qbPushed: true }, { qbPendingRemoteInvoice: { Id: "q" } },
    { source: "quickbooks", qbSpsOnly: true }, { sentDate: "2026-09-01" },
    { exportedAt: "2026-09-01" }, { paymentLink: "https://example.test/pay" },
    { payment: { amount: 100 } }, { payments: [{ id: "payment-1" }] },
    { paidDate: "2026-09-01" }, { balance: 50 }, { amountPaid: 1 }, { partial: true },
  ]) assert.equal(invoiceBulkDeleteEligibility(draft("draft-1", evidence), context()).eligible, false, JSON.stringify(evidence));
  assert.equal(invoiceBulkDeleteEligibility(draft("draft-1", { qbSpsOnly: true, qbSyncStatus: "sps-only" }), context()).eligible, true);
});

test("prepaid policy and month allocation references protect invoice identity and number", () => {
  const invoice = draft();
  for (const ledger of [
    { version: 1, policies: { "sample-client": { version: 1, mode: "prepaid", coveredFrom: "2026-01-01", coveredThrough: "2026-12-31", sourceInvoiceId: invoice.id } } },
    { version: 2, policies: {}, allocations: { "sample-client": { "2026-10": { status: "paid", sources: [{ kind: "invoice", invoiceId: invoice.id }] } } } },
    { version: 2, policies: {}, allocations: { "sample-client": { "2026-10": { status: "prepaid", sources: [{ kind: "prepaid", invoiceNumber: invoice.number }] } } } },
  ]) assert.equal(invoiceBulkDeleteEligibility(invoice, { ledger }).code, "payment-coverage");
  assert.equal(invoiceBulkDeleteEligibility(invoice, {}).code, "coverage-unavailable");
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ledger: { version: 2, allocations: "broken" } }).code, "coverage-unavailable");
});

test("linked jobs remain protected while unreferenced auto-generated drafts can be removed", () => {
  const invoice = draft("draft-1", { sourceStopId: "stop-1", autoDraftKey: "stop-1:completion" });
  assert.equal(invoiceBulkDeleteEligibility(invoice, context()).eligible, true);
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ...context(), schedule: [{ stops: [{ sid: "stop-1", linkedInvoiceId: invoice.id }] }] }).code, "job-linked");
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ...context(), estimates: [{ id: "estimate-1", linkedInvoiceId: invoice.id }] }).code, "job-linked");
});

test("review matching permits sequential draft renumbering but detects changed client or charges", () => {
  const invoice = draft();
  assert.equal(invoiceDeletionReviewMatches(invoice, { ...invoice, number: "INV-0", previousDraftNumber: invoice.number, draftNumberAdjustedAt: "now" }), true);
  assert.equal(invoiceDeletionReviewMatches(invoice, { ...invoice, lineItems: [{ desc: "Repair", qty: 1, unitPrice: 200 }] }), false);
  assert.equal(invoiceDeletionReviewMatches(invoice, { ...invoice, clientId: "different-client" }), false);
  assert.equal(invoiceDeletionReviewMatches(null, invoice), false);
});

test("batch deletion is sequential and retains failed, protected, and unconfirmed invoices", async () => {
  const invoices = [draft("draft-1"), draft("draft-2"), draft("draft-3"), draft("draft-4", { status: "Paid" }), draft("draft-5")];
  const calls = [];
  let active = 0;
  const result = await deleteSelectedInvoiceDrafts({
    invoices, selectedIds: invoices.map((invoice) => invoice.id), context: context(),
    onDelete: async (id, options) => {
      assert.equal(++active, 1);
      assert.equal(options.draftOnly, true);
      calls.push(id);
      await Promise.resolve();
      active -= 1;
      if (id === "draft-2") throw new Error("Offline");
      if (id === "draft-3") return undefined;
      if (id === "draft-5") return { ok: false, protected: true, error: "Now linked to QuickBooks" };
      return { ok: true };
    },
  });
  assert.deepEqual(calls, ["draft-1", "draft-2", "draft-3", "draft-5"]);
  assert.deepEqual(result.deletedIds, ["draft-1"]);
  assert.deepEqual(new Set(result.retainedIds), new Set(["draft-2", "draft-3", "draft-4", "draft-5"]));
});

// Exercise the actual app handler with versioned, in-memory sections. No API,
// database, or business records are accessed by these transaction tests.
async function deletionHarness(invoices, options = {}) {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("  const handleDeleteInvoice = async");
  const end = app.indexOf("\n  // Re-read the three authoritative sections", start);
  const rows = Object.fromEntries(Object.entries({ sps_invoices: invoices, sps_estimates: [], sps_schedule: [], sps_maintenance_billing: options.ledger || emptyMaintenancePaymentLedger() }).map(([key, value]) => [key, { ok: true, exists: true, value: JSON.stringify(value), version: 1 }]));
  const writes = [];
  const store = {
    flush: async () => ({ ok: true }), listConflicts: () => [],
    refresh: async (key) => structuredClone(rows[key]),
    get: async (key) => options.invalidConfirmation ? { value: "invalid" } : structuredClone(rows[key]),
    replaceMany: async (changes) => {
      writes.push(changes);
      if (options.beforeWrite) await options.beforeWrite(rows, writes.length);
      if (changes.some((change) => change.expectedVersion !== rows[change.key].version)) return { ok: false, conflict: true };
      changes.forEach((change) => { rows[change.key] = { ...rows[change.key], value: change.value, version: rows[change.key].version + 1 }; });
      return { ok: true };
    },
  };
  const deps = { store, perms: { isAdmin: true, invoiceDelete: true }, emptyMaintenancePaymentLedger, normalizeMaintenancePaymentLedger, invoiceBulkDeleteEligibility, invoiceDeletionReviewMatches, findInvoiceDeletionReferences, invoiceDeletionBlockedMessage, deleteInvoiceAndCompactSafeDrafts, invoiceTotals: (invoice) => ({ total: invoice.total }), setInvoices: () => {}, setEstimatesRaw: () => {}, setSchedule: () => {}, qbIsConnected: () => { throw new Error("Bulk deletion must never inspect QuickBooks connection"); } };
  const handle = Function(...Object.keys(deps), `${app.slice(start, end)}\nreturn handleDeleteInvoice;`)(...Object.values(deps));
  return { handle, rows, writes };
}

test("bulk handler fences the unchanged authoritative ledger in the confirmed delete transaction", async () => {
  const invoice = draft();
  const harness = await deletionHarness([invoice]);
  const priorLedger = harness.rows.sps_maintenance_billing.value;
  assert.equal((await harness.handle(invoice.id, { draftOnly: true, reviewedInvoice: invoice })).ok, true);
  assert.deepEqual(harness.writes[0].find((operation) => operation.key === "sps_maintenance_billing"), { key: "sps_maintenance_billing", value: priorLedger, expectedVersion: 1 });
  assert.equal(harness.rows.sps_maintenance_billing.value, priorLedger);
});

test("a simultaneous payment allocation forces a recheck and preserves the draft", async () => {
  const invoice = draft();
  const harness = await deletionHarness([invoice], { beforeWrite: async (rows, attempt) => {
    if (attempt !== 1) return;
    rows.sps_maintenance_billing = { ...rows.sps_maintenance_billing, version: 2, value: JSON.stringify({ version: 2, policies: {}, allocations: { "sample-client": { "2026-10": { status: "paid", sources: [{ kind: "invoice", invoiceId: invoice.id }] } } } }) };
  } });
  const result = await harness.handle(invoice.id, { draftOnly: true, reviewedInvoice: invoice });
  assert.equal(result.ok, false);
  assert.equal(result.protected, true);
  assert.match(result.error, /payment coverage/);
  assert.equal(harness.writes.length, 1);
  assert.equal(JSON.parse(harness.rows.sps_invoices.value).length, 1);
});

test("freshly synced or changed drafts and malformed confirmations never report deletion success", async () => {
  const reviewed = draft();
  for (const fresh of [draft("draft-1", { qbId: "qb-1" }), draft("draft-1", { clientId: "changed" })]) {
    const harness = await deletionHarness([fresh]);
    assert.equal((await harness.handle(fresh.id, { draftOnly: true, reviewedInvoice: reviewed })).ok, false);
    assert.equal(harness.writes.length, 0);
  }
  const harness = await deletionHarness([reviewed], { invalidConfirmation: true });
  assert.equal((await harness.handle(reviewed.id, { draftOnly: true, reviewedInvoice: reviewed })).ok, false);
});
