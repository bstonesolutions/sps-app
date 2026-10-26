import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteConfirmedQuickBooksInvoice, invoiceDeletionRelatedConflicts, invoiceDeletionReviewRequest, refreshInvoiceDeletionReview,
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

function deletionContext() {
  const linked = { ...invoice, status: "Sent", qbId: "qb-20" };
  const identity = { uid: "owner" };
  const values = { sps_invoices: [], sps_estimates: [], sps_schedule: [], sps_maintenance_billing: {} };
  const receipt = { success: true, complete: true, actorId: identity.uid, deletedInvoiceId: linked.id, values };
  const calls = [];
  const store = {
    captureIdentity: () => identity, isCurrentIdentity: candidate => candidate === identity,
    acceptInvoiceDeletionSnapshot: async (...args) => { calls.push(args); return {ok: true, values}; },
  };
  const adopted = [];
  return {linked, identity, values, receipt, calls, store, adopted, adopt: async (...args) => adopted.push(args)};
}

test("linked deletion captures the reviewed fields before awaiting its confirmation", async () => {
  const ctx = deletionContext();
  const original = structuredClone(ctx.linked);
  const result = await deleteConfirmedQuickBooksInvoice({ invoice: ctx.linked, store: ctx.store, adopt: ctx.adopt,
    requestDelete: async body => {
      assert.equal(body.completeInSps, true);
      ctx.linked.total = 999;
      assert.equal(body.reviewed_invoice.total, 175);
      return ctx.receipt;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(ctx.calls[0][2], {expectedInvoice: original});
  assert.deepEqual(ctx.adopted[0][1], {deletedInvoice: {id: original.id, before: original}});
});

test("wrong actor, wrong target, and incomplete receipts never hide an invoice", async () => {
  for (const override of [{actorId: "other"}, {deletedInvoiceId: "other"}, {complete: false}, {success: false}]) {
    const ctx = deletionContext();
    await assert.rejects(deleteConfirmedQuickBooksInvoice({invoice: ctx.linked, store: ctx.store, adopt: ctx.adopt, requestDelete: async () => ({...ctx.receipt, ...override})}), /not confirmed/);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.adopted.length, 0);
  }
});

test("account changes while deletion is in flight prevent receipt adoption", async () => {
  const ctx = deletionContext();
  await assert.rejects(deleteConfirmedQuickBooksInvoice({invoice: ctx.linked, store: ctx.store, adopt: ctx.adopt, requestDelete: async () => {
    ctx.store.isCurrentIdentity = () => false;
    return ctx.receipt;
  }}), /signed-in account changed/);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.adopted.length, 0);
});

test("a newer local invoice edit remains visible as recovery after confirmed server deletion", async () => {
  const ctx = deletionContext();
  ctx.store.acceptInvoiceDeletionSnapshot = async () => ({ok: false, targetChanged: true, error: new Error("Your newer local invoice edit is preserved")});
  const result = await deleteConfirmedQuickBooksInvoice({invoice: ctx.linked, store: ctx.store, adopt: ctx.adopt, requestDelete: async () => ctx.receipt});
  assert.equal(result.ok, false);
  assert.equal(result.serverConfirmed, true);
  assert.equal(result.targetChanged, true);
  assert.equal(ctx.adopted.length, 0);
});

test("confirmed deletion with recovered local work is a successful removal with a clear notice", async () => {
  const ctx = deletionContext();
  ctx.store.acceptInvoiceDeletionSnapshot = async () => ({ok: true, recoveryPending: true, values: ctx.values});
  const result = await deleteConfirmedQuickBooksInvoice({invoice: ctx.linked, store: ctx.store, adopt: ctx.adopt, requestDelete: async () => ctx.receipt});
  assert.equal(result.ok, true);
  assert.equal(result.recoveryPending, true);
  assert.equal(result.message, "Invoice removed. Newer local edits are preserved for review.");
  assert.equal(ctx.adopted.length, 1);
});

test("failed device persistence does not misreport a confirmed deletion as a QB failure", async () => {
  const ctx = deletionContext();
  ctx.store.acceptInvoiceDeletionSnapshot = async () => { throw new Error("device storage unavailable"); };
  const result = await deleteConfirmedQuickBooksInvoice({invoice: ctx.linked, store: ctx.store, adopt: ctx.adopt, requestDelete: async () => ctx.receipt});
  assert.equal(result.serverConfirmed, true);
  assert.match(result.error, /deleted on the server/);
  assert.equal(ctx.adopted.length, 0);
});

test("a projected invoice still present cannot become a false deletion success", async () => {
  const ctx = deletionContext();
  ctx.values.sps_invoices = [ctx.linked];
  const result = await deleteConfirmedQuickBooksInvoice({invoice: ctx.linked, store: ctx.store, adopt: ctx.adopt, requestDelete: async () => ctx.receipt});
  assert.equal(result.ok, false);
  assert.equal(result.serverConfirmed, true);
  assert.equal(ctx.adopted.length, 0);
});
