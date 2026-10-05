// Narrow accounting-authorized mutation for prepaid maintenance coverage.
// Ordinary client profile writes are operational and intentionally available
// to client-editing staff, so they cannot be the authority for suppressing an
// invoice. This route updates the UI mirror and the protected policy ledger in
// one version-checked transaction.

import { requireCapability } from "./_staff-auth.js";
import {
  APP_STATE_SERVICE_KEY, APP_STATE_SUPABASE_URL, withAppStateRequestDeadline,
} from "./_app-state.js";
import {
  normalizeMaintenanceBillingPolicy,
} from "../maintenanceBilling.js";
import {
  emptyMaintenancePaymentLedger,
  normalizeMaintenancePaymentLedger,
} from "../maintenancePaymentLedger.js";

const MAX_ATTEMPTS = 6;
const DATA_DEADLINE_MS = 45_000;
const FETCH_TIMEOUT_MS = Math.max(250, Math.min(20_000,
  Math.round(Number(process.env.CLIENT_MAINTENANCE_BILLING_TIMEOUT_MS) || 20_000)));
const RECOVERY_TIMEOUT_MS = Math.min(5_000, FETCH_TIMEOUT_MS);
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const sameId = (left, right) => String(left) === String(right);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

// This route can spend up to 45 seconds on its normal transaction and reserves
// five more seconds to verify a write whose response was interrupted.
export const config = { maxDuration: 60 };

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
}

function cleanId(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, 220);
}

async function billingRpc(name, body, requestOptions = {}) {
  if (!APP_STATE_SERVICE_KEY) throw new Error("server_not_configured");
  return withAppStateRequestDeadline(name, async (signal) => {
    const response = await fetch(`${APP_STATE_SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST", signal,
      headers: {
        apikey: APP_STATE_SERVICE_KEY, Authorization: `Bearer ${APP_STATE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw Object.assign(new Error("maintenance_billing_rpc_failed"), {
        status: response.status, code: String(payload?.code || "MAINTENANCE_BILLING_RPC_ERROR"), operation: name,
      });
    }
    return Array.isArray(payload) ? payload[0] : payload;
  }, requestOptions);
}

// The client roster contains large historic reports. Fetch only this client's
// billing projection; the RPC keeps the full roster inside the database.
async function readBaseline(clientId, requestOptions = {}) {
  const snapshot = await billingRpc("sps_client_maintenance_billing_snapshot", { p_client_id: clientId }, requestOptions);
  if (!isRecord(snapshot) || !Number.isSafeInteger(Number(snapshot.match_count))
    || Number(snapshot.match_count) < 0 || !Number.isSafeInteger(Number(snapshot.clients_version))
    || Number(snapshot.clients_version) < 1 || typeof snapshot.billing_exists !== "boolean"
    || !Number.isSafeInteger(Number(snapshot.billing_version))
    || Number(snapshot.billing_version) < (snapshot.billing_exists ? 1 : 0)) throw new Error("shared_billing_snapshot_invalid");
  if (Number(snapshot.match_count) === 1 && (!isRecord(snapshot.client) || !sameId(snapshot.client.id, clientId))) {
    throw new Error("shared_client_projection_invalid");
  }
  const billingValue = snapshot.billing_exists
    ? normalizeMaintenancePaymentLedger(snapshot.ledger)
    : emptyMaintenancePaymentLedger();
  if (!billingValue) throw new Error("shared_maintenance_billing_invalid");
  return {
    matchCount: Number(snapshot.match_count),
    clients: { value: snapshot.client ? [snapshot.client] : [], version: Number(snapshot.clients_version) },
    billing: { exists: snapshot.billing_exists, version: Number(snapshot.billing_version), value: billingValue },
  };
}

async function savePolicy(baseline, clientId, policy, ledger, requestOptions) {
  const result = await billingRpc("sps_client_maintenance_billing_cas", {
    p_client_id: clientId,
    p_expected_clients_version: baseline.clients.version,
    p_expected_billing_version: baseline.billing.exists ? baseline.billing.version : 0,
    p_maintenance_billing: policy,
    p_ledger: ledger,
  }, requestOptions);
  if (!isRecord(result) || typeof result.applied !== "boolean") throw new Error("maintenance_billing_cas_invalid_response");
  if (result.applied && (!isRecord(result.client) || !sameId(result.client.id, clientId)
    || JSON.stringify(normalizeMaintenanceBillingPolicy(result.client.maintenanceBilling)) !== JSON.stringify(policy))) {
    throw new Error("maintenance_billing_cas_invalid_response");
  }
  return result;
}

function receipt(client, policy, versions, extra = {}) {
  // This is a billing projection, never a replacement for the full client profile.
  return { ok: true, client, clientProjection: true, maintenanceBilling: policy, versions, ...extra };
}

function baselineVersions(baseline) {
  return { sps_clients: baseline.clients.version, sps_maintenance_billing: baseline.billing.version };
}

function isTransientFailure(error) {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  return code === "APP_STATE_REQUEST_TIMEOUT"
    || error?.name === "AbortError"
    || error?.name === "TypeError"
    || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(code)
    || code.startsWith("UND_ERR_")
    || Number(error?.status) >= 500;
}

function savedPolicyMatches(baseline, clientId, requestedPolicy) {
  if (baseline.matchCount !== 1) return null;
  const clients = baseline.clients.value.filter((client) => client && sameId(client.id, clientId));
  if (clients.length !== 1) return null;
  const client = clients[0];
  const policy = baseline.billing.value.policies[clientId];
  if (requestedPolicy) {
    const expected = JSON.stringify(requestedPolicy);
    if (JSON.stringify(normalizeMaintenanceBillingPolicy(client.maintenanceBilling)) !== expected
      || JSON.stringify(policy) !== expected) return null;
  } else if (hasOwn(client, "maintenanceBilling") || hasOwn(baseline.billing.value.policies, clientId)) {
    return null;
  }
  return client;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const staff = await requireCapability(
    req,
    res,
    "invoiceCreate",
    "changing prepaid maintenance billing",
  );
  if (!staff) return;

  const clientId = cleanId(req.body?.clientId);
  const hasPolicy = isRecord(req.body) && Object.prototype.hasOwnProperty.call(req.body, "maintenanceBilling");
  if (!clientId || !hasPolicy) {
    return res.status(400).json({ ok: false, error: "A client and maintenance billing choice are required." });
  }
  const requestedPolicy = req.body.maintenanceBilling == null
    ? null
    : normalizeMaintenanceBillingPolicy(req.body.maintenanceBilling);
  if (req.body.maintenanceBilling != null && !requestedPolicy) {
    return res.status(400).json({
      ok: false,
      error: "Prepaid coverage must start on the first day of a month and end on the last day of a month.",
    });
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + DATA_DEADLINE_MS;
  let phase = "read-baseline";
  let attempts = 0;
  let uncertainCommit = false;
  const requestOptions = (operation) => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 250) {
      throw Object.assign(new Error("app_state_request_timeout"), {
        code: "APP_STATE_REQUEST_TIMEOUT", operation, timeoutMs: Math.max(0, remainingMs),
      });
    }
    return { timeoutMs: Math.min(FETCH_TIMEOUT_MS, remainingMs) };
  };
  const logFailure = (error, event = "request_failed") => console.error("[client-maintenance-billing]", JSON.stringify({
    event, phase, attempts, durationMs: Math.max(0, Date.now() - startedAt),
    code: String(error?.code || error?.name || "MAINTENANCE_BILLING_ERROR").slice(0, 80),
    operation: String(error?.operation || "").slice(0, 80),
    timeoutMs: Number(error?.timeoutMs) || 0,
  }));

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      phase = "read-baseline";
      let baseline;
      // A read has no side effects. Retry one interrupted exchange within the
      // total deadline; a write with an uncertain outcome is only verified.
      for (let readAttempt = 0; readAttempt < 2; readAttempt += 1) {
        try {
          baseline = await readBaseline(clientId, requestOptions("billing-snapshot"));
          break;
        } catch (error) {
          if (readAttempt || !isTransientFailure(error)) throw error;
          logFailure(error, "read_retry");
        }
      }
      if (!baseline.matchCount) {
        return res.status(404).json({ ok: false, error: "The client no longer exists." });
      }
      if (baseline.matchCount !== 1) {
        return res.status(409).json({
          ok: false,
          error: "This client ID appears more than once. Merge the duplicate client records before changing billing.",
        });
      }

      const alreadySavedClient = savedPolicyMatches(baseline, clientId, requestedPolicy);
      if (alreadySavedClient) {
        return res.status(200).json(receipt(alreadySavedClient, requestedPolicy, baselineVersions(baseline), { alreadySaved: true }));
      }

      const policies = { ...baseline.billing.value.policies };
      if (requestedPolicy) policies[clientId] = requestedPolicy;
      else delete policies[clientId];
      const nextBilling = normalizeMaintenancePaymentLedger({
        ...baseline.billing.value,
        policies,
      });
      if (!nextBilling) throw new Error("shared_maintenance_billing_invalid");

      const writeOptions = requestOptions("billing-cas");
      phase = "save-policy";
      uncertainCommit = true;
      const saved = await savePolicy(baseline, clientId, requestedPolicy, nextBilling, writeOptions);
      uncertainCommit = false;
      if (saved.applied) {
        return res.status(200).json(receipt(saved.client, requestedPolicy, saved.current_versions));
      }
      if (saved.outcome !== "conflict") throw new Error(`unexpected_batch_outcome:${saved.outcome || "unknown"}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.floor(Math.random() * 20)));
      }
    }
    return res.status(409).json({
      ok: false,
      error: "Another employee changed this client at the same time. Nothing was changed; please try again.",
    });
  } catch (error) {
    if (uncertainCommit && (isTransientFailure(error) || error?.message === "maintenance_billing_cas_invalid_response")) {
      logFailure(error);
      phase = "verify-save";
      let confirmedClient = null;
      let confirmation;
      try {
        confirmation = await readBaseline(clientId, { timeoutMs: RECOVERY_TIMEOUT_MS });
        confirmedClient = savedPolicyMatches(confirmation, clientId, requestedPolicy);
      } catch (verificationError) {
        logFailure(verificationError, "save_verification_failed");
      }
      if (confirmedClient) {
        return res.status(200).json(receipt(confirmedClient, requestedPolicy, baselineVersions(confirmation), { confirmedAfterUncertainWrite: true }));
      }
      return res.status(503).json({
        ok: false, code: "maintenance-billing-save-unconfirmed", retryable: true, commitState: "unconfirmed",
        error: "The server could not confirm your billing change. Your selections are kept here. Retry Save to check and finish it.",
      });
    }
    logFailure(error);
    if (error?.code === "PGRST202") {
      return res.status(503).json({
        ok: false, code: "maintenance-billing-unavailable", retryable: true, commitState: "not-started",
        error: "The billing save service is being updated. Your selections are kept here. Please retry Save shortly.",
      });
    }
    if (error?.code === "APP_STATE_REQUEST_TIMEOUT" || isTransientFailure(error)) {
      return res.status(504).json({
        ok: false, code: "maintenance-billing-data-timeout", retryable: true, commitState: "not-started",
        error: "Loading the saved client billing took too long. Your selections are kept here. Please retry Save.",
      });
    }
    return res.status(502).json({
      ok: false,
      error: "Maintenance billing could not be saved safely. Nothing was changed; please try again.",
    });
  }
}
