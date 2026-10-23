import { requireCapability, memberHasCapability } from "./_staff-auth.js";
import { readAppStateVersioned, readAppStatesVersioned, decodeAppStateValue } from "./_app-state.js";
import { compareAndSetSharedStatePatch, compareAndSetSharedStatePatchBatch } from "./_shared-state-patch.js";
import { applySharedStateIntent, validateSharedStateIntent } from "../sharedStateIntent.js";
import { stableInvoiceReviewJSON } from "../invoiceReviewIdentity.js";
import { findInvoiceDeletionReferences, unlinkInvoiceDeletionReferences } from "../invoiceDeletionGuard.js";
import { invoiceBulkDeleteEligibility, unlinkUnpaidInvoiceCoverage } from "../invoiceBulkDeletion.js";
import { deleteInvoiceAndCompactSafeDrafts } from "../invoiceNumbering.js";
import { maintenanceInvoiceTotalCents } from "../maintenancePaymentLedger.js";

export const config = { maxDuration: 60 };
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const same = (a, b) => String(a ?? "") === String(b ?? "");
const billingFields = new Set(["monthlyRate", "planRates", "autoInvoice", "balance"]);
const identityFields = new Set(["auth_user_id", "authUserId", "portalAuthUid", "qbId", "qbCustomerId"]);
const equal = (a, b) => stableInvoiceReviewJSON(a) === stableInvoiceReviewJSON(b);
const protectedKeys = new Set(["sps_clients", "sps_schedule"]);
const list = value => Array.isArray(value) ? value : [];
const allStops = value => list(value).flatMap(day => list(day.stops));
const ownerAction = action => ["restore", "media-migration", "reset"].includes(action);

function operationAlreadyPresent(operation, current) {
  const records = operation.entity === "client" ? current : operation.entity === "stop"
    ? list(current).flatMap(day => list(day.stops).map(stop => ({ date: day.date, stop }))) : list(current).map(({ stops, ...day }) => day);
  const matches = records.filter(record => same(operation.entity === "stop" ? record?.stop?.sid : operation.entity === "day" ? record?.date : record?.id, operation.entityId));
  if (matches.length !== 1 || !["set", "add"].includes(operation.kind)) return false;
  let present = true, value = matches[0];
  for (const part of operation.path || []) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) { present = false; break; }
    value = value[part];
  }
  return present === operation.next.present && (!present || equal(value, operation.next.value));
}

function checkPolicy(intent, staff, current, { action = "", includesBillingLedger = false } = {}) {
  const owner = staff.teamRole === "owner" || staff.teamMember?.role === "owner";
  const canBill = memberHasCapability(staff.teamMember, "invoiceCreate");
  if (intent.key === "sps_schedule") {
    for (const operation of intent.operations) {
      if (operation.entity !== "stop" || operationAlreadyPresent(operation, current)) continue;
      const existing = allStops(current).find(stop => same(stop.sid, operation.entityId));
      if (operation.kind === "delete" && existing?.sourceEstimateId && !["restore", "reset"].includes(action)) throw fail(409, "shared-state-estimate-stop-protected", "This stop belongs to an estimate. Open that estimate before removing its scheduled work.");
      const field = operation.path?.[1], nextStop = operation.kind === "add" ? operation.next.value?.stop : null;
      if (nextStop && (nextStop.completionReceiptId || nextStop.completedAt || nextStop.estimateFulfillment?.completionReceiptId
        || nextStop.estimateFulfillment?.completedAt || nextStop.estimateFulfillment?.state === "completed")
        && !["restore", "reset"].includes(action)) throw fail(409, "shared-state-completion-required", "Create the scheduled stop first, then complete it through its service report.");
      const financial = /^(sourceEstimate|linkedInvoice|linkedBillingReview|estimate|billingDisposition)/.test(field || "")
        || nextStop && Object.keys(nextStop).some(key => /^(sourceEstimate|linkedInvoice|linkedBillingReview|estimate|billingDisposition)/.test(key));
      if (financial && !canBill) throw fail(403, "shared-state-billing-forbidden", "Your team permissions do not allow changing scheduled billing links.");
      if ((field === "sourceEstimateId" || nextStop?.sourceEstimateId) && !["estimate-schedule", "restore", "reset"].includes(action)) throw fail(409, "shared-state-estimate-link-required", "Schedule this work from its approved estimate so both records keep the same link.");
      if ((["completionReceiptId", "completedAt"].includes(field) || field === "estimateFulfillment" && (!operation.path?.[2] || ["completionReceiptId", "completedAt", "state"].includes(operation.path[2])))
        && !["estimate-schedule", "restore", "reset"].includes(action)) throw fail(409, "shared-state-completion-required", "Use the scheduled stop's completion or report action to change its saved completion.");
    }
    return;
  }
  for (const operation of intent.operations) {
    if (operationAlreadyPresent(operation, current)) continue;
    const root = operation.path?.[0];
    if ((root === "maintenanceBilling" || (operation.kind === "add" && operation.next.value?.maintenanceBilling)) && !(owner && ["restore", "reset"].includes(action) && includesBillingLedger)) {
      throw fail(409, "shared-state-targeted-billing-required", "Save prepaid coverage through the client billing settings so its payment ledger stays consistent.");
    }
    if (identityFields.has(root) && !owner) throw fail(403, "shared-state-identity-forbidden", "Owner access is required to change linked client accounts.");
    if (billingFields.has(root) && !canBill) throw fail(403, "shared-state-billing-forbidden", "Your team permissions do not allow changing client billing details.");
    if (operation.kind === "add") {
      const client = operation.next.value;
      if (!client || !same(client.id, operation.entityId) || typeof client.name !== "string" || !client.name.trim()) throw fail(400, "shared-state-client-invalid", "A client needs a stable identity and a name.");
      if (!owner && [...identityFields].some(key => client[key] != null && client[key] !== "")) throw fail(403, "shared-state-identity-forbidden", "Owner access is required to import linked client accounts.");
      if (!canBill && (Number(client.monthlyRate || 0) !== 0 || Number(String(client.balance || "0").replace(/[$,]/g, "")) !== 0
        || Object.values(client.planRates || {}).some(value => Number(value) !== 0) || (client.autoInvoice && client.autoInvoice !== "Off"))) {
        throw fail(403, "shared-state-billing-forbidden", "Your team permissions do not allow creating clients with billing details.");
      }
    }
    if (root === "name" && (!operation.next.present || typeof operation.next.value !== "string" || !operation.next.value.trim())) throw fail(400, "shared-state-client-name-required", "A client name cannot be empty.");
    // Existing accepted-report SQL protection still runs. Ordinary unreceipted
    // history imports remain supported by the same editClients permission.
  }
}

function validateBatch(body) {
  const validAction = ["estimate-schedule", "invoice-unlink", "restore", "media-migration", "reset"].includes(body?.action);
  if (body?.protocol !== 1 || body.mode !== "batch" || !validAction || typeof body.operationId !== "string" || !body.operationId.trim() || body.operationId.length > 320
    || !Array.isArray(body.operations) || !body.operations.length || body.operations.length > 128) throw fail(400, "shared-state-batch-invalid", "This transaction could not be read.");
  const seen = new Set();
  for (const operation of body.operations) {
    if (!operation || !/^sps_[A-Za-z0-9_]+$/.test(operation.key) || seen.has(operation.key) || ["sps_team", "sps_session"].includes(operation.key) || operation.key.startsWith("sps_track_")
      || !Number.isSafeInteger(operation.expectedVersion) || operation.expectedVersion < 0) throw fail(400, "shared-state-batch-invalid", "This transaction has an invalid section or baseline.");
    seen.add(operation.key);
    if (protectedKeys.has(operation.key)) {
      validateSharedStateIntent(operation.intent);
      if (operation.intent.key !== operation.key || Object.hasOwn(operation, "value")) throw fail(400, "shared-state-batch-invalid", "A protected section needs its original field intent.");
    } else if (!Object.hasOwn(operation, "value") || Object.hasOwn(operation, "intent")) throw fail(400, "shared-state-batch-invalid", "A transaction section is incomplete.");
  }
  if (![...seen].some(key => protectedKeys.has(key))) throw fail(400, "shared-state-batch-invalid", "This transaction has no protected section.");
  const allowed = body.action === "estimate-schedule" ? ["sps_estimates", "sps_schedule", "sps_invoices"]
    : body.action === "invoice-unlink" ? ["sps_invoices", "sps_estimates", "sps_schedule", "sps_maintenance_billing"]
      : body.action === "media-migration" ? ["sps_clients"] : null;
  if (allowed && (seen.size !== allowed.length || allowed.some(key => !seen.has(key)))) throw fail(400, "shared-state-batch-scope-invalid", "The related records required for this transaction are incomplete.");
}

function validateLinkedTransaction(action, before, values) {
  if (action === "estimate-schedule") {
    if (!equal(before.sps_invoices.value, values.sps_invoices)) throw fail(409, "shared-state-estimate-accounting-protected", "Scheduling an estimate cannot change accounting records.");
    const oldStops = allStops(before.sps_schedule.value), nextStops = allStops(values.sps_schedule);
    if (oldStops.some(stop => !nextStops.some(next => same(next.sid, stop.sid)))) throw fail(409, "shared-state-estimate-stop-protected", "Scheduling an estimate cannot remove existing stops.");
    for (const stop of nextStops.filter(next => !oldStops.some(old => equal(old, next)))) {
      const old = oldStops.find(item => same(item.sid, stop.sid));
      const estimate = list(before.sps_estimates.value).filter(item => same(item.id, stop.sourceEstimateId));
      const nextEstimate = list(values.sps_estimates).filter(item => same(item.id, stop.sourceEstimateId));
      if (estimate.length !== 1 || nextEstimate.length !== 1 || (!old && !["approved", "accepted"].includes(String(estimate[0].status).toLowerCase()))
        || old && !same(old.sourceEstimateId, stop.sourceEstimateId) || !same(stop.clientId || stop.id, estimate[0].clientId)
        || !same(nextEstimate[0].linkedScheduledStopId, stop.sid)) throw fail(409, "shared-state-estimate-link-invalid", "The scheduled stop must match one approved estimate and its client.");
      if (["completionReceiptId", "completedAt"].some(field => !same(stop[field], old?.[field]) || !same(stop.estimateFulfillment?.[field], old?.estimateFulfillment?.[field]))) throw fail(409, "shared-state-completion-required", "Scheduling cannot change a completion report.");
      if ((stop.estimateFulfillment?.state === "completed" || old?.estimateFulfillment?.state === "completed") && stop.estimateFulfillment?.state !== old?.estimateFulfillment?.state) throw fail(409, "shared-state-completion-required", "Scheduling cannot change completed work.");
    }
  }
  if (action === "invoice-unlink") {
    const removed = list(before.sps_invoices.value).filter(invoice => !list(values.sps_invoices).some(next => same(next.id, invoice.id)));
    if (removed.length !== 1) throw fail(409, "shared-state-invoice-delete-scope", "Remove one reviewed invoice at a time.");
    const eligibilityContext = { invoices: before.sps_invoices.value, estimates: before.sps_estimates.value, schedule: before.sps_schedule.value,
      ledger: before.sps_maintenance_billing.value, totalOf: invoice => maintenanceInvoiceTotalCents(invoice) / 100 };
    const eligibility = invoiceBulkDeleteEligibility(removed[0], { ...eligibilityContext, includeQuickBooks: true, unlinkJobs: true, reviewedInvoice: removed[0] });
    if (!eligibility.eligible) throw fail(409, "shared-state-invoice-protected", eligibility.reason);
    const protectedInvoiceIds = new Set(list(before.sps_invoices.value).filter(invoice => findInvoiceDeletionReferences(invoice, before.sps_estimates.value, before.sps_schedule.value).blocked
      || !invoiceBulkDeleteEligibility(invoice, eligibilityContext).eligible).map(invoice => String(invoice.id)));
    const now = list(values.sps_invoices).find(invoice => invoice.draftNumberAdjustedAt && !equal(invoice, list(before.sps_invoices.value).find(old => same(old.id, invoice.id))))?.draftNumberAdjustedAt;
    const expectedInvoices = deleteInvoiceAndCompactSafeDrafts(before.sps_invoices.value, removed[0].id, { protectedInvoiceIds, ...(now ? { now } : {}) }).invoices;
    if (!equal(expectedInvoices, values.sps_invoices)) throw fail(409, "shared-state-invoice-delete-scope", "Invoice cleanup cannot change other invoice content.");
    const expected = unlinkInvoiceDeletionReferences(removed[0], before.sps_estimates.value, before.sps_schedule.value);
    if (!equal(expected.estimates, values.sps_estimates) || !equal(expected.schedule, values.sps_schedule)
      || !equal(unlinkUnpaidInvoiceCoverage(removed[0], before.sps_maintenance_billing.value), values.sps_maintenance_billing)) throw fail(409, "shared-state-invoice-unlink-scope", "Invoice cleanup may remove only that invoice's unpaid job links.");
  }
}

async function handleBatch(req, res, deps) {
  const body = req.body;
  try { validateBatch(body); } catch (error) { return res.status(400).json({ ok: false, code: error.code || "shared-state-batch-invalid", error: error.message }); }
  const staff = await deps.authorize(req, res, body.action === "invoice-unlink" ? "invoiceDelete" : body.action === "estimate-schedule" ? "editSchedule" : "editClients", "saving related shared records");
  if (!staff) return;
  if (ownerAction(body.action) && staff.teamRole !== "owner" && staff.teamMember?.role !== "owner") return res.status(403).json({ ok: false, error: "Owner access is required for restoring or migrating shared records." });
  if (!ownerAction(body.action) && !memberHasCapability(staff.teamMember, "invoiceCreate")) return res.status(403).json({ ok: false, error: "Billing access is required for changing estimate or invoice links." });
  try {
    const snapshot = await deps.readMany(body.operations.map(operation => operation.key));
    const values = {}, conflicts = [];
    let changed = false, staleVersion = false;
    for (const operation of body.operations) {
      const row = snapshot[operation.key];
      if (!row || !Number.isSafeInteger(row.version) || row.version < 0) throw fail(503, "shared-state-snapshot-invalid", "A required saved section could not be read.");
      staleVersion ||= row.version !== operation.expectedVersion;
      if (protectedKeys.has(operation.key)) {
        if (!row.exists || !Array.isArray(row.value)) throw fail(503, "shared-state-snapshot-invalid", "The saved records could not be read.");
        checkPolicy(operation.intent, staff, row.value, { action: body.action, includesBillingLedger: Object.hasOwn(snapshot, "sps_maintenance_billing") });
        const result = await deps.apply(operation.intent, row.value);
        values[operation.key] = result.value; changed ||= result.changed;
        conflicts.push(...result.conflicts.map(conflict => ({ ...conflict, key: operation.key })));
      } else {
        values[operation.key] = decodeAppStateValue(operation.value);
        changed ||= !row.exists || !equal(row.value, values[operation.key]);
      }
    }
    if (conflicts.length) return res.status(409).json({ ok: false, code: "shared-state-field-conflict", actorId: staff.id, operationId: body.operationId, conflicts, error: "A related record changed. Review the saved details before retrying this transaction." });
    const beforeVersions = Object.fromEntries(body.operations.map(operation => [operation.key, snapshot[operation.key].version]));
    if (!changed) return res.status(200).json({ ok: true, actorId: staff.id, operationId: body.operationId, beforeVersions, versions: beforeVersions, values, complete: true, replayed: true });
    if (staleVersion) return res.status(409).json({ ok: false, code: "shared-state-batch-conflict", operationId: body.operationId, currentVersions: beforeVersions, error: "A related record changed after this transaction was prepared. Refresh and review it before saving." });
    validateLinkedTransaction(body.action, snapshot, values);
    const operations = body.operations.map(operation => ({ key: operation.key, expectedVersion: operation.expectedVersion, value: values[operation.key] }));
    const expectedCurrent = Object.fromEntries(operations.filter(operation => protectedKeys.has(operation.key)).map(operation => [operation.key, snapshot[operation.key].value]));
    const saved = operations.length === 1
      ? await deps.cas(operations[0].key, operations[0].expectedVersion, snapshot[operations[0].key].value, operations[0].value, { actorId: staff.id })
      : await deps.batch(operations, { actorId: staff.id, expectedCurrent });
    if (!saved.applied) return res.status(409).json({ ok: false, code: "shared-state-batch-conflict", operationId: body.operationId, error: "A related record changed while saving. Refresh and review the transaction before trying again." });
    const versions = operations.length === 1 ? { [operations[0].key]: saved.currentVersion } : saved.currentVersions;
    const confirmed = operations.length === 1 ? { [operations[0].key]: saved.value } : saved.values;
    if (operations.some(operation => !Number.isSafeInteger(versions?.[operation.key]) || versions[operation.key] < operation.expectedVersion
      || !Object.hasOwn(confirmed || {}, operation.key) || !equal(confirmed[operation.key], operation.value))) throw fail(409, "shared-state-protected-change", "A protected record rejected part of this transaction. Review the saved details before continuing.");
    return res.status(200).json({ ok: true, actorId: staff.id, operationId: body.operationId, beforeVersions, versions, values: confirmed, complete: true, replayed: false });
  } catch (error) {
    const status = [400, 403, 409].includes(error.status) ? error.status : 503;
    return res.status(status).json({ ok: false, code: error.code || "shared-state-batch-unconfirmed", operationId: body.operationId,
      error: status === 503 ? "The server could not confirm this transaction. Keep your changes and retry to check the same save." : error.message,
      ...(status === 503 ? { retryable: true, commitState: "unconfirmed" } : {}) });
  }
}

export function createSharedStatePatchHandler(overrides = {}) {
  const deps = { authorize: requireCapability, read: readAppStateVersioned, readMany: readAppStatesVersioned, cas: compareAndSetSharedStatePatch, batch: compareAndSetSharedStatePatchBatch, apply: applySharedStateIntent, ...overrides };
  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
    if (req.body?.mode === "batch") return handleBatch(req, res, deps);
    let intent;
    try { validateSharedStateIntent(req.body); intent = req.body; }
    catch (_) { return res.status(400).json({ ok: false, code: "invalid-shared-state-intent", error: "This save request could not be read. Your changes are still on this device." }); }
    const staff = await deps.authorize(req, res, intent.key === "sps_clients" ? "editClients" : "editSchedule", intent.key === "sps_clients" ? "editing clients" : "editing the schedule");
    if (!staff) return;
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const before = await deps.read(intent.key);
        if (!before.exists || !Array.isArray(before.value) || !Number.isSafeInteger(before.version) || before.version < 1) throw fail(503, "shared-state-snapshot-invalid", "The saved records could not be read. Your changes are still on this device.");
        checkPolicy(intent, staff, before.value);
        const result = await deps.apply(intent, before.value);
        if (!result.applied || result.conflicts.length) return res.status(409).json({ ok: false, code: "shared-state-field-conflict", key: intent.key, operationId: intent.operationId,
          actorId: staff.id, currentVersion: before.version, conflicts: result.conflicts, error: "Another saved change overlaps this edit. Review the current details before choosing which change to keep." });
        if (!result.changed) return res.status(200).json({ ok: true, actorId: staff.id, key: intent.key, operationId: intent.operationId, beforeVersion: before.version, afterVersion: before.version, value: before.value, complete: true, replayed: true });
        const saved = await deps.cas(intent.key, before.version, before.value, result.value, { actorId: staff.id });
        if (saved.applied) {
          if (!Number.isSafeInteger(saved.currentVersion) || saved.currentVersion < before.version || !Array.isArray(saved.value)) throw fail(503, "shared-state-receipt-invalid", "The saved change could not be verified.");
          if (stableInvoiceReviewJSON(saved.value) !== stableInvoiceReviewJSON(result.value)) throw fail(409, "shared-state-protected-change", "A protected report or shared record could not accept part of this change. Your original work is still on this device. Review the saved details before continuing.");
          return res.status(200).json({ ok: true, actorId: staff.id, key: intent.key, operationId: intent.operationId, beforeVersion: before.version,
            afterVersion: saved.currentVersion, value: saved.value, complete: true, replayed: false });
        }
        if (!["conflict", "current-changed"].includes(saved.outcome)) throw fail(409, "shared-state-save-needs-review", "This change needs review before it can be saved. Your original work is still on this device.");
      }
      throw fail(409, "shared-state-contention", "The records changed repeatedly while saving. Your changes are still available. Please retry.");
    } catch (error) {
      const status = [400, 403, 409].includes(error.status) ? error.status : 503;
      return res.status(status).json({ ok: false, code: error.code || "shared-state-save-unconfirmed", key: intent.key, operationId: intent.operationId,
        error: status === 503 ? "The server could not confirm this save. Your changes are still on this device. Retry to check the same change." : error.message,
        ...(status === 503 ? { retryable: true, commitState: "unconfirmed" } : {}) });
    }
  };
}

export default createSharedStatePatchHandler();
