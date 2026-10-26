// Service-only accounting persistence. Never fall back to the generic writer:
// only this RPC may establish a new confirmed QuickBooks accounting snapshot.
import { APP_STATE_SERVICE_KEY, APP_STATE_SUPABASE_URL, decodeAppStateValue, withAppStateRequestDeadline } from "./_app-state.js";

const actions = new Set(["quickbooks-refresh", "quickbooks-create", "quickbooks-update", "quickbooks-payment"]);
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const failure = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

export async function compareAndSetCanonicalInvoices(expectedVersion, value, {
  actorId, action, authority = {}, candidates = {}, metadataCandidates = {}, diagnostics = {}, fetchImpl = globalThis.fetch, ...requestOptions
} = {}) {
  const version = Number(expectedVersion);
  if (!Number.isSafeInteger(version) || version < 1 || !Array.isArray(value)
    || !String(actorId || "").trim() || !actions.has(action) || !object(authority) || !object(candidates) || !object(metadataCandidates) || !object(diagnostics)) {
    throw failure("INVOICE_CANONICAL_SCOPE_INVALID", "The confirmed invoice save scope is invalid.", 400);
  }
  if (!APP_STATE_SERVICE_KEY) throw failure("INVOICE_CANONICAL_NOT_CONFIGURED", "Shared invoice persistence is not configured.");
  return withAppStateRequestDeadline("invoice-canonical-cas", async signal => {
    const response = await fetchImpl(`${APP_STATE_SUPABASE_URL}/rest/v1/rpc/sps_invoice_canonical_cas`, {
      method: "POST", signal,
      headers: { apikey: APP_STATE_SERVICE_KEY, Authorization: `Bearer ${APP_STATE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_expected_version: version, p_value: JSON.stringify(value),
        p_actor_id: String(actorId), p_action: action, p_authority: authority, p_candidates: candidates,
        ...(Object.keys(metadataCandidates).length ? { p_metadata_candidates: metadataCandidates } : {}),
        ...(Object.keys(diagnostics).length ? { p_diagnostics: diagnostics } : {}) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      // Keep a safe database code in server diagnostics without echoing raw
      // Postgres details (which may contain invoice contents) to the client.
      const databaseCode = /^[A-Z0-9]{5}$/.test(String(payload?.code || "")) ? String(payload.code) : null;
      const permanentConflict = databaseCode === "PT409" && response.status === 409;
      const timedOut = databaseCode === "57014";
      const error = failure(permanentConflict ? "INVOICE_CANONICAL_CONFLICT" : timedOut ? "INVOICE_CANONICAL_TIMEOUT" : "INVOICE_CANONICAL_SAVE_FAILED",
        permanentConflict ? "This invoice changed or has a protected accounting link. Review its current details before trying this change again."
          : timedOut ? "The invoice refresh took too long to save. No replacement was confirmed. Retry to check the saved invoices."
          : `Shared invoice persistence could not confirm this save (${response.status}).`, permanentConflict ? 409 : timedOut ? 503 : response.status);
      if (permanentConflict) error.retryable = false;
      if (databaseCode) error.databaseCode = databaseCode;
      if (/^(invoice|shared)_[a-z_]+$/.test(String(payload?.message || ""))) error.databaseReason = payload.message;
      throw error;
    }
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!object(row) || typeof row.applied !== "boolean") throw failure("INVOICE_CANONICAL_RESPONSE_INVALID", "Shared invoice persistence returned an unreadable receipt.");
    const currentVersion = row.current_version == null ? null : Number(row.current_version);
    const savedValue = row.value == null ? null : decodeAppStateValue(row.value);
    if (row.applied && (!Number.isSafeInteger(currentVersion) || currentVersion < version || !Array.isArray(savedValue))) {
      throw failure("INVOICE_CANONICAL_RESPONSE_INVALID", "Shared invoice persistence returned an incomplete receipt.");
    }
    return { applied: row.applied, outcome: String(row.outcome || ""),
      currentVersion: Number.isSafeInteger(currentVersion) ? currentVersion : null,
      changedAt: row.changed_at || null, value: savedValue };
  }, requestOptions);
}
