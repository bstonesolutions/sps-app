import test from "node:test";
import assert from "node:assert/strict";
import { createSharedStatePatchHandler } from "../api/shared-state-patch.js";
import { buildSharedStateIntent } from "../sharedStateIntent.js";
import { scheduleApprovedEstimate } from "../estimateScheduleLink.js";
import { unlinkInvoiceDeletionReferences } from "../invoiceDeletionGuard.js";
import { emptyMaintenancePaymentLedger } from "../maintenancePaymentLedger.js";
import { deleteInvoiceAndCompactSafeDrafts } from "../invoiceNumbering.js";

const clone = value => structuredClone(value);
const owner = { id: "owner-1", teamRole: "owner", teamMember: { role: "owner" } };
const response = () => ({ statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
async function transaction(action, before, after) {
  const operations = [];
  for (const [key, value] of Object.entries(after)) {
    operations.push(["sps_clients", "sps_schedule"].includes(key)
      ? { key, expectedVersion: 2, intent: await buildSharedStateIntent(key, before[key], value, { operationId: `tx:${key}` }) }
      : { key, expectedVersion: 2, value: clone(value) });
  }
  return { protocol: 1, mode: "batch", operationId: "tx", action, operations };
}
function harness(initial, { staff = owner, onBatch } = {}) {
  const rows = Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, { key, exists: true, version: 2, value: clone(value) }]));
  const calls = { reads: 0, writes: 0, scope: null };
  const write = async (operations, scope) => {
    calls.writes += 1; calls.scope = scope;
    for (const operation of operations) {
      assert.equal(operation.expectedVersion, rows[operation.key].version);
      if (["sps_clients", "sps_schedule"].includes(operation.key)) assert.deepEqual(scope.expectedCurrent[operation.key], rows[operation.key].value);
    }
    const special = await onBatch?.({ rows, operations });
    if (special) return special;
    for (const operation of operations) rows[operation.key] = { key: operation.key, exists: true, version: operation.expectedVersion + 1, value: clone(operation.value) };
    return { applied: true, currentVersions: Object.fromEntries(operations.map(operation => [operation.key, rows[operation.key].version])), values: Object.fromEntries(operations.map(operation => [operation.key, clone(rows[operation.key].value)])) };
  };
  const handler = createSharedStatePatchHandler({
    authorize: async (_req, res) => { if (!staff) { res.status(403).json({ error: "Forbidden" }); return null; } return staff; },
    readMany: async keys => { calls.reads += 1; return Object.fromEntries(keys.map(key => [key, clone(rows[key])])); },
    batch: write,
    cas: async (key, version, expectedCurrent, proposed, { actorId }) => { const result = await write([{ key, expectedVersion: version, value: proposed }], { actorId, expectedCurrent: { [key]: expectedCurrent } }); return { applied: result.applied, currentVersion: result.currentVersions?.[key], value: result.values?.[key] }; },
  });
  return { rows, calls, async call(body) { const res = response(); await handler({ method: "POST", body }, res); return res; } };
}

const estimate = { id: "e1", number: "1011", clientId: "c1", status: "approved", title: "Repair", items: [{ id: "line1", description: "Repair", qty: 1, price: 100, unitPrice: 100, kind: "service" }] };
const client = { id: "c1", name: "Client One" };
const scheduled = () => scheduleApprovedEstimate(estimate, [], { client, date: "10/23/2026", createdAt: "2026-10-22T15:00:00Z" });

test("approved estimate scheduling saves both links atomically with the original schedule intent", async () => {
  const plan = scheduled(), before = { sps_estimates: [estimate], sps_schedule: [], sps_invoices: [] };
  const h = harness(before);
  const result = await h.call(await transaction("estimate-schedule", before, { sps_estimates: [plan.estimate], sps_schedule: plan.schedule, sps_invoices: [] }));
  assert.equal(result.statusCode, 200); assert.equal(h.calls.writes, 1);
  assert.equal(result.body.actorId, owner.id);
  assert.equal(h.calls.scope.actorId, owner.id);
  assert.equal(h.rows.sps_estimates.value[0].linkedScheduledStopId, h.rows.sps_schedule.value[0].stops[0].sid);
  assert.deepEqual(result.body.values.sps_schedule, plan.schedule);
});

test("a newer companion estimate version rejects the complete old scheduling transaction", async () => {
  const plan = scheduled(), before = { sps_estimates: [estimate], sps_schedule: [], sps_invoices: [] };
  const body = await transaction("estimate-schedule", before, { sps_estimates: [plan.estimate], sps_schedule: plan.schedule, sps_invoices: [] });
  const h = harness(before); h.rows.sps_estimates.version += 1; h.rows.sps_estimates.value[0].notes = "Newer approved scope";
  const result = await h.call(body);
  assert.equal(result.statusCode, 409); assert.equal(result.body.code, "shared-state-batch-conflict"); assert.equal(h.calls.writes, 0);
});

test("lost batch response confirms the same completed transaction without duplicating scheduled work", async () => {
  const plan = scheduled(), before = { sps_estimates: [estimate], sps_schedule: [], sps_invoices: [] };
  const body = await transaction("estimate-schedule", before, { sps_estimates: [plan.estimate], sps_schedule: plan.schedule, sps_invoices: [] });
  const h = harness(before, { onBatch({ rows, operations }) {
    for (const operation of operations) rows[operation.key] = { key: operation.key, exists: true, version: 3, value: clone(operation.value) };
    throw new Error("lost reply");
  } });
  assert.equal((await h.call(body)).statusCode, 503);
  const replay = await h.call(body);
  assert.equal(replay.statusCode, 200); assert.equal(replay.body.replayed, true); assert.equal(h.calls.writes, 1);
});

test("unapproved or mismatched estimate sources cannot become scheduled work through the batch route", async () => {
  const plan = scheduled(), before = { sps_estimates: [{ ...estimate, status: "draft" }], sps_schedule: [], sps_invoices: [] };
  const h = harness(before);
  const result = await h.call(await transaction("estimate-schedule", before, { sps_estimates: [plan.estimate], sps_schedule: plan.schedule, sps_invoices: [] }));
  assert.equal(result.statusCode, 409); assert.equal(result.body.code, "shared-state-estimate-link-invalid"); assert.equal(h.calls.writes, 0);
});

test("estimate scheduling cannot attach a top-level completion receipt to its new stop", async () => {
  const plan = scheduled(), before = { sps_estimates: [estimate], sps_schedule: [], sps_invoices: [] };
  plan.schedule[0].stops[0].completionReceiptId = "forged";
  const h = harness(before), result = await h.call(await transaction("estimate-schedule", before, { sps_estimates: [plan.estimate], sps_schedule: plan.schedule, sps_invoices: [] }));
  assert.equal(result.statusCode, 409); assert.equal(result.body.code, "shared-state-completion-required"); assert.equal(h.calls.writes, 0);
});

test("invoice cleanup removes only the deleted invoice backlink while retaining estimate provenance", async () => {
  const invoice = { id: "i1", number: "2101", status: "Draft" };
  const before = { sps_invoices: [invoice], sps_estimates: [{ ...estimate, linkedInvoiceId: "i1" }],
    sps_schedule: [{ date: "10/23/2026", stops: [{ sid: "s1", clientId: "c1", sourceEstimateId: "e1", linkedInvoiceId: "i1", notes: "Keep report" }] }], sps_maintenance_billing: emptyMaintenancePaymentLedger() };
  const unlinked = unlinkInvoiceDeletionReferences(invoice, before.sps_estimates, before.sps_schedule);
  const h = harness(before);
  const result = await h.call(await transaction("invoice-unlink", before, { sps_invoices: [], sps_estimates: unlinked.estimates, sps_schedule: unlinked.schedule, sps_maintenance_billing: before.sps_maintenance_billing }));
  assert.equal(result.statusCode, 200);
  const stop = h.rows.sps_schedule.value[0].stops[0];
  assert.equal(stop.sourceEstimateId, "e1"); assert.equal(stop.notes, "Keep report"); assert.equal(stop.linkedInvoiceId, undefined);
});

test("invoice cleanup cannot use its action label to rewrite another stop field", async () => {
  const before = { sps_invoices: [{ id: "i1", status: "Draft" }], sps_estimates: [], sps_schedule: [{ date: "10/23/2026", stops: [{ sid: "s1", notes: "Keep" }] }], sps_maintenance_billing: emptyMaintenancePaymentLedger() };
  const after = clone(before); after.sps_invoices = []; after.sps_schedule[0].stops[0].notes = "Overwrite";
  const h = harness(before), result = await h.call(await transaction("invoice-unlink", before, after));
  assert.equal(result.statusCode, 409); assert.equal(result.body.code, "shared-state-invoice-unlink-scope"); assert.equal(h.calls.writes, 0);
});

test("invoice cleanup retains the existing safe draft-number compaction behavior", async () => {
  const before = { sps_invoices: [{ id: "i1", number: "1001", status: "Draft" }, { id: "i2", number: "1002", status: "Draft" }], sps_estimates: [], sps_schedule: [], sps_maintenance_billing: emptyMaintenancePaymentLedger() };
  const after = { ...before, sps_invoices: deleteInvoiceAndCompactSafeDrafts(before.sps_invoices, "i1", { now: "2026-10-22T15:00:00Z" }).invoices };
  const h = harness(before), result = await h.call(await transaction("invoice-unlink", before, after));
  assert.equal(result.statusCode, 200); assert.equal(h.rows.sps_invoices.value[0].number, "1001");
});

test("invoice cleanup cannot remove paid records or change a different invoice", async () => {
  for (const paid of [true, false]) {
    const before = { sps_invoices: [{ id: "i1", number: "1001", status: paid ? "Paid" : "Draft" }, { id: "i2", number: "1002", status: "Sent", notes: "Keep" }], sps_estimates: [], sps_schedule: [], sps_maintenance_billing: emptyMaintenancePaymentLedger() };
    const after = { ...before, sps_invoices: [{ ...before.sps_invoices[1], notes: "Replaced" }] };
    const h = harness(before), result = await h.call(await transaction("invoice-unlink", before, after));
    assert.equal(result.statusCode, 409); assert.equal(h.calls.writes, 0);
    assert.equal(result.body.code, paid ? "shared-state-invoice-protected" : "shared-state-invoice-delete-scope");
  }
});

test("restore remains owner-only and cannot transfer team, session, or tracking credentials", async () => {
  const before = { sps_clients: [client] }, after = { sps_clients: [{ ...client, name: "Restored name" }] };
  const body = await transaction("restore", before, after);
  const h = harness(before, { staff: { id: "lead", teamMember: { role: "lead" } } });
  assert.equal((await h.call(body)).statusCode, 403); assert.equal(h.calls.reads, 0);
  for (const key of ["sps_team", "sps_session", "sps_track_secret"]) {
    const result = await harness(before).call({ ...body, operations: [...body.operations, { key, expectedVersion: 1, value: [] }] });
    assert.equal(result.statusCode, 400);
  }
});

test("owner media migration uses only its captured original client fields and checks the saved result", async () => {
  const before = { sps_clients: [{ ...client, sitePhotos: ["data:photo"] }] }, after = { sps_clients: [{ ...client, sitePhotos: ["sps-storage://media/ref"] }] };
  const h = harness(before), result = await h.call(await transaction("media-migration", before, after));
  assert.equal(result.statusCode, 200); assert.equal(h.calls.writes, 1);
  assert.deepEqual(h.calls.scope.expectedCurrent.sps_clients, before.sps_clients);
});

test("guard normalization cannot falsely confirm an atomic batch", async () => {
  const before = { sps_clients: [client], sps_schedule: [] }, after = { ...before, sps_clients: [{ ...client, name: "Requested" }] };
  const h = harness(before, { onBatch() { return { applied: true, currentVersions: { sps_clients: 3, sps_schedule: 3 }, values: before }; } });
  const result = await h.call(await transaction("restore", before, after));
  assert.equal(result.statusCode, 409); assert.equal(result.body.code, "shared-state-protected-change");
});
