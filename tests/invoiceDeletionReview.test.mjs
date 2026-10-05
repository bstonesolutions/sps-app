import assert from "node:assert/strict";
import test from "node:test";
import {
  invoiceDeletionRelatedConflicts, invoiceDeletionReviewRequest, refreshInvoiceDeletionReview,
  resolveInvoiceDeletionConflict, snapshotInvoiceDeletionReview,
} from "../invoiceDeletionReview.js";

const invoice = { id: "draft-a", number: "INV-20", clientName: "Demo Client", total: 175, status: "Draft", lineItems: [{ desc: "Service", qty: 1, unitPrice: 175 }] };

test("deletion request binds the reviewed snapshot and explicit unlink choice", () => {
  const reviewed = snapshotInvoiceDeletionReview(invoice);
  const request = invoiceDeletionReviewRequest(reviewed);
  assert.equal(request.id, invoice.id);
  assert.equal(request.options.includeQuickBooks, false);
  assert.equal(request.options.unlinkJobs, false);
  reviewed.lineItems[0].unitPrice = 500;
  assert.equal(request.options.reviewedInvoice.lineItems[0].unitPrice, 175);
  assert.equal(invoice.lineItems[0].unitPrice, 175);
  const linked = invoiceDeletionReviewRequest({ ...invoice, qbId: "qb-20" }, true);
  assert.equal(linked.options.includeQuickBooks, true);
  assert.equal(linked.options.unlinkJobs, true);
  assert.throws(() => invoiceDeletionReviewRequest({}), /Choose an invoice/);
});

test("an explicit conflict choice resolves only that key and retains unrelated pending work", async () => {
  const calls = [];
  const invoiceConflict = { key: "sps_invoices", paths: ["$.draft-a.total"] };
  const scheduleConflict = { key: "sps_schedule", paths: ["$.day.stops"] };
  const inventoryConflict = { key: "sps_catalog", paths: ["$.price"] };
  let pending = [invoiceConflict, scheduleConflict, inventoryConflict];
  const store = {
    listConflicts: () => pending,
    resolveConflict: async (key, strategy) => { calls.push([key, strategy]); pending = pending.filter(conflict => conflict.key !== key); return { ok: true }; },
  };
  const result = await resolveInvoiceDeletionConflict(store, invoiceConflict, "remote");
  assert.deepEqual(calls, [["sps_invoices", "remote"]]);
  assert.deepEqual(result.conflicts, [scheduleConflict]);
  assert.deepEqual(pending, [scheduleConflict, inventoryConflict]);
  assert.deepEqual(invoiceDeletionRelatedConflicts(store), [scheduleConflict]);
  await assert.rejects(resolveInvoiceDeletionConflict(store, inventoryConflict, "local"), /displayed invoice-related/);
  await assert.rejects(resolveInvoiceDeletionConflict(store, scheduleConflict, "automatic"), /displayed invoice-related/);
  assert.equal(calls.length, 1);
});

test("conflict failures remain explicit and never retry with another version choice", async () => {
  const calls = [];
  const store = { resolveConflict: async (...args) => { calls.push(args); return { ok: false, conflict: true }; } };
  await assert.rejects(resolveInvoiceDeletionConflict(store, { key: "sps_invoices" }, "local"), /saved copy changed again/);
  assert.deepEqual(calls, [["sps_invoices", "local"]]);
});

test("refresh rereads the target after conflict resolution without deleting or flushing other keys", async () => {
  const calls = [];
  const changed = { ...invoice, total: 225, qbId: "qb-current" };
  const store = {
    refresh: async key => { calls.push(["refresh", key]); return { ok: true, exists: true, value: JSON.stringify([changed]) }; },
    listConflicts: () => [{ key: "sps_catalog", paths: ["$.price"] }],
  };
  const result = await refreshInvoiceDeletionReview(store, invoice.id);
  assert.equal(result.invoice.total, 225);
  assert.equal(result.invoice.qbId, "qb-current");
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(calls, [["refresh", "sps_invoices"]]);
  result.invoice.total = 300;
  assert.equal(changed.total, 225);
});

test("a missing, malformed, duplicate or unreadable saved invoice cannot become a guessed target", async () => {
  assert.equal((await refreshInvoiceDeletionReview({ refresh: async () => ({ ok: true, exists: false }) }, invoice.id)).invoice, null);
  for (const response of [
    { ok: false, error: new Error("offline") },
    { ok: true, value: "broken" },
    { ok: true, value: { invoices: [] } },
    { ok: true, value: [invoice, invoice] },
  ]) await assert.rejects(refreshInvoiceDeletionReview({ refresh: async () => response }, invoice.id));
});
