// Exact-baseline server writes for client profiles and schedules. Generic snapshot
// writers are intentionally not a fallback if the protected RPC is unavailable.
import { APP_STATE_SERVICE_KEY, APP_STATE_SUPABASE_URL, decodeAppStateValue, NO_APP_STATE_CHANGE, readAppStateVersioned, withAppStateRequestDeadline } from "./_app-state.js";
import { stableInvoiceReviewJSON } from "../invoiceReviewIdentity.js";
import { createHash } from "node:crypto";

const keys = new Set(["sps_clients", "sps_schedule"]);
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const rejectedWrites = new Map();
const REJECTION_TTL_MS = 10_000;
const MAX_REJECTED_WRITES = 128;

async function callRpc(name, body, { fetchImpl = globalThis.fetch, now = Date.now, ...requestOptions } = {}) {
  if (!APP_STATE_SERVICE_KEY) throw fail("SHARED_STATE_PATCH_UNAVAILABLE", "The shared save service is not configured.");
  const wireBody = JSON.stringify(body);
  // Old installations may replay a permanent rejection on every refresh. Keep
  // only its exact request hash for ten seconds in this worker. Actor, original
  // fields, proposed values and versions are all part of the hash; changing any
  // of them requires a fresh database decision. No record data is cached.
  const requestHash = createHash("sha256").update(name).update("\0").update(wireBody).digest("hex");
  const timestamp = () => { const value = Number(now()); return Number.isFinite(value) ? value : Date.now(); };
  const startedAt = timestamp();
  for (const [hash, item] of rejectedWrites) {
    if (item.expiresAt <= startedAt || startedAt < item.expiresAt - REJECTION_TTL_MS) rejectedWrites.delete(hash);
  }
  const cached = rejectedWrites.get(requestHash);
  if (cached) throw fail(cached.code, cached.message, 409);
  return withAppStateRequestDeadline(name, async signal => {
    const response = await fetchImpl(`${APP_STATE_SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc/${name}`, {
      method: "POST", signal,
      headers: { apikey: APP_STATE_SERVICE_KEY, Authorization: `Bearer ${APP_STATE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: wireBody,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      // Identify the failing section without logging a customer record, JWT,
      // actor, or raw database detail. This is a rejected save, not success.
      const affected = body.p_key ? [body.p_key] : (body.p_operations || []).map(operation => operation.key);
      const databaseCode = /^[A-Z0-9]{5}$/.test(String(payload?.code || "")) ? payload.code : null;
      const databaseReason = /^(shared|stop|invoice)_[a-z_]+$/.test(String(payload?.message || "")) ? payload.message : null;
      console.error("[shared-state-patch]", JSON.stringify({ event: "database_rejected", rpc: name,
        keys: affected.filter(key => /^sps_[a-z_]+$/.test(String(key))), status: response.status, databaseCode, databaseReason }));
      const rejection = payload?.message === "shared_deleted_identity_reused"
        ? fail("SHARED_STATE_DELETED_IDENTITY", "This client or stop was removed after the original save. Review the current records before creating a replacement.", 409)
        : payload?.message === "shared_schedule_delete_requires_action"
          ? fail("SHARED_STATE_STOP_DELETE_ACTION_REQUIRED", "A background save cannot remove scheduled stops. Use the stop's Delete action to review and remove it.", 409)
        : payload?.message === "shared_state_protected_change_rejected"
          ? fail("SHARED_STATE_PATCH_PROTECTED_CHANGE", "A protected service report could not accept this change. Open the saved report to edit it without replacing other work.", 409) : null;
      if (rejection) {
        // PT409 is the non-retrying database business-conflict response. Keep
        // compatibility with old named 40001 responses during rollout only.
        // Real serialization errors and generic 500s are never cached.
        if ([400, 409, 500].includes(response.status) && ["PT409", "40001"].includes(databaseCode)) {
          while (rejectedWrites.size >= MAX_REJECTED_WRITES) rejectedWrites.delete(rejectedWrites.keys().next().value);
          rejectedWrites.set(requestHash, { expiresAt: timestamp() + REJECTION_TTL_MS, code: rejection.code, message: rejection.message });
        }
        throw rejection;
      }
      throw fail("SHARED_STATE_PATCH_SAVE_UNCONFIRMED", "The server could not confirm this save. Your changes are still available to retry.", 503);
    }
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!object(row) || typeof row.applied !== "boolean") throw fail("SHARED_STATE_PATCH_RECEIPT_INVALID", "The shared save service returned an incomplete receipt.");
    return row;
  }, requestOptions);
}

export async function compareAndSetSharedStatePatch(key, expectedVersion, expectedCurrent, proposed, { actorId, deleteStopIds, operationId, ...options } = {}) {
  const version = Number(expectedVersion);
  if (!keys.has(key) || !Number.isSafeInteger(version) || version < 1 || !Array.isArray(expectedCurrent)
    || !Array.isArray(proposed) || !String(actorId || "").trim()) {
    throw fail("SHARED_STATE_PATCH_SCOPE_INVALID", "The shared save scope is invalid.", 400);
  }
  let row;
  if (deleteStopIds !== undefined) {
    if (key !== "sps_schedule" || !Array.isArray(deleteStopIds) || !deleteStopIds.length || !String(operationId || "").trim()) throw fail("SHARED_STATE_PATCH_SCOPE_INVALID", "The selected stop removals need their original operation.", 400);
    const batch = await callRpc("sps_schedule_delete_patch_batch_cas", {
      p_operations: [{ key, expected_version: version, value: JSON.stringify(proposed) }],
      p_expected_current: { [key]: expectedCurrent }, p_stop_ids: deleteStopIds,
      p_actor_id: String(actorId), p_operation_id: String(operationId),
    }, options);
    row = { ...batch, current_version: batch.current_versions?.[key], value: batch.values?.[key] };
  } else row = await callRpc("sps_shared_state_patch_cas", {
      p_key: key, p_expected_version: version, p_expected_current: expectedCurrent,
      p_proposed: JSON.stringify(proposed), p_actor_id: String(actorId),
    }, options);
  const currentVersion = Number(row.current_version), value = decodeAppStateValue(row.value);
  if (row.applied && (!Number.isSafeInteger(currentVersion) || currentVersion < version || !Array.isArray(value))) {
    throw fail("SHARED_STATE_PATCH_RECEIPT_INVALID", "The server did not return the saved records and their version.");
  }
  if (row.applied && stableInvoiceReviewJSON(value) !== stableInvoiceReviewJSON(proposed)) throw fail("SHARED_STATE_PATCH_PROTECTED_CHANGE", "A protected shared record could not accept part of this change. Review the saved details before continuing.", 409);
  return { applied: row.applied, outcome: String(row.outcome || ""),
    currentVersion: Number.isSafeInteger(currentVersion) ? currentVersion : null,
    changedAt: row.changed_at || null, value };
}

export async function compareAndSetSharedStatePatchBatch(operations, { expectedCurrent, actorId, deleteStopIds, operationId, ...options } = {}) {
  if (!Array.isArray(operations) || operations.length < 2 || !object(expectedCurrent) || !String(actorId || "").trim()) throw fail("SHARED_STATE_PATCH_SCOPE_INVALID", "The shared save scope is invalid.", 400);
  const seen = new Set(), scoped = [];
  const wire = operations.map(operation => {
    const key = String(operation?.key || ""), version = Number(operation?.expectedVersion), checkOnly = operation?.checkOnly === true;
    if (!key || seen.has(key) || !Number.isSafeInteger(version) || version < 0 || (checkOnly ? version === 0 : !Object.hasOwn(operation, "value"))) throw fail("SHARED_STATE_PATCH_SCOPE_INVALID", "The shared transaction is invalid.", 400);
    seen.add(key);
    if (keys.has(key) && !checkOnly) {
      if (!Array.isArray(expectedCurrent[key]) || !Array.isArray(operation.value)) throw fail("SHARED_STATE_PATCH_SCOPE_INVALID", "The shared transaction needs its original records.", 400);
      scoped.push(key);
    }
    return { key, expected_version: version, ...(checkOnly ? { check_only: true } : { value: JSON.stringify(operation.value) }) };
  });
  if (!scoped.length || Object.keys(expectedCurrent).some(key => !scoped.includes(key))) throw fail("SHARED_STATE_PATCH_SCOPE_INVALID", "The shared transaction scope is invalid.", 400);
  if (deleteStopIds !== undefined && (!Array.isArray(deleteStopIds) || !deleteStopIds.length || !scoped.includes("sps_schedule") || !String(operationId || "").trim())) throw fail("SHARED_STATE_PATCH_SCOPE_INVALID", "The transaction needs its selected stop removals.", 400);
  const row = await callRpc(deleteStopIds === undefined ? "sps_shared_state_patch_batch_cas" : "sps_schedule_delete_patch_batch_cas", {
    p_operations: wire, p_expected_current: expectedCurrent, p_actor_id: String(actorId),
    ...(deleteStopIds === undefined ? {} : { p_stop_ids: deleteStopIds, p_operation_id: String(operationId) }),
  }, options);
  if (row.applied && (!object(row.current_versions) || !object(row.values))) throw fail("SHARED_STATE_PATCH_RECEIPT_INVALID", "The shared transaction returned an incomplete receipt.");
  const values = object(row.values) ? Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, decodeAppStateValue(value)])) : {};
  if (row.applied && scoped.some(key => !Array.isArray(values[key]) || stableInvoiceReviewJSON(values[key]) !== stableInvoiceReviewJSON(operations.find(operation => operation.key === key).value))) {
    throw fail("SHARED_STATE_PATCH_PROTECTED_CHANGE", "A protected shared record could not accept part of this transaction. Review the saved details before continuing.", 409);
  }
  return { applied: row.applied, outcome: String(row.outcome || ""), conflictKey: row.conflict_key || null,
    currentVersions: object(row.current_versions) ? row.current_versions : {},
    values };
}

// Existing narrow portal operations use a fresh baseline on every retry. The
// updater is already ownership checked and must have no external side effects.
export async function mutateSharedStatePatch(key, updater, { actorId, read = readAppStateVersioned, cas = compareAndSetSharedStatePatch, maxAttempts = 6 } = {}) {
  if (!keys.has(key) || typeof updater !== "function" || !String(actorId || "").trim()) throw fail("SHARED_STATE_PATCH_SCOPE_INVALID", "The shared save scope is invalid.", 400);
  for (let attempt = 1; attempt <= Math.min(6, maxAttempts); attempt += 1) {
    const current = await read(key);
    if (!current.exists || !Array.isArray(current.value)) throw fail("SHARED_STATE_PATCH_SNAPSHOT_INVALID", "The saved records could not be read.");
    const proposed = await updater(current.value, { attempt, version: current.version, exists: true });
    if (proposed === NO_APP_STATE_CHANGE) return { changed: false, value: current.value, version: current.version, attempts: attempt };
    const result = await cas(key, current.version, current.value, proposed, { actorId });
    if (result.applied) return { changed: result.currentVersion !== current.version, value: result.value, version: result.currentVersion, attempts: attempt };
    if (!["conflict", "current-changed"].includes(result.outcome)) throw fail("SHARED_STATE_PATCH_REJECTED", "The saved records need review before this change can be applied.", 409);
  }
  throw fail("SHARED_STATE_PATCH_CONTENTION", "These records changed repeatedly. Your changes are still available. Please retry.", 409);
}
