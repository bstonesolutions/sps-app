import { memberHasCapability, requireCapability } from "./_staff-auth.js";
import { APP_STATE_SERVICE_KEY, APP_STATE_SUPABASE_URL, withAppStateRequestDeadline } from "./_app-state.js";
import { canonicalizeNewClientProfile, stableClientCreateJSON } from "../clientCreateProfile.js";

export const config = { maxDuration: 60 };
const FETCH_TIMEOUT_MS = Math.max(250, Math.min(20_000, Math.round(Number(process.env.CLIENT_CREATE_TIMEOUT_MS) || 20_000)));
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameId = (left, right) => left != null && right != null && String(left) === String(right);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
}

async function createClientRpc(client, allowBilling) {
  if (!APP_STATE_SERVICE_KEY) throw Object.assign(new Error("server_not_configured"), { code: "CLIENT_CREATE_UNAVAILABLE" });
  return withAppStateRequestDeadline("sps_client_create", async signal => {
    const response = await fetch(`${APP_STATE_SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc/sps_client_create`, {
      method: "POST", signal,
      headers: { apikey: APP_STATE_SERVICE_KEY, Authorization: `Bearer ${APP_STATE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_request_id: client.id, p_client: client, p_allow_billing: allowBilling }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw Object.assign(new Error("client_create_rpc_failed"), {
        status: response.status,
        code: typeof payload?.message === "string" && /^client_create_[a-z_]+$/.test(payload.message)
          ? payload.message : String(payload?.code || "CLIENT_CREATE_RPC_ERROR"),
      });
    }
    return Array.isArray(payload) ? payload[0] : payload;
  }, { timeoutMs: FETCH_TIMEOUT_MS });
}

function compactReceipt(row, requested) {
  const before = Number(row?.before_version), after = Number(row?.current_version);
  if (!isRecord(row) || !isRecord(row.client) || !sameId(row.client.id, requested.id)
    || row.request_id !== requested.id || typeof row.replayed !== "boolean" || typeof row.applied !== "boolean"
    || !Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(after) || after < before
    || typeof row.client.name !== "string" || !row.client.name.trim()
    || (!row.replayed && (row.outcome !== "created" || !row.applied || after !== before + 1))
    || (row.replayed && (row.outcome !== "replayed" || row.applied || after !== before))) {
    throw Object.assign(new Error("client_create_receipt_invalid"), { code: "CLIENT_CREATE_RECEIPT_INVALID" });
  }
  if (!row.replayed && stableClientCreateJSON(row.client) !== stableClientCreateJSON(requested)) {
    throw Object.assign(new Error("client_create_receipt_invalid"), { code: "CLIENT_CREATE_RECEIPT_INVALID" });
  }
  return {
    ok: true, client: row.client, beforeVersion: before, afterVersion: after,
    replayed: row.replayed, requestId: row.request_id,
    ...(row.client_projection === true ? { clientProjection: true } : {}),
  };
}

const transient = error => error?.code === "APP_STATE_REQUEST_TIMEOUT"
  || error?.code === "CLIENT_CREATE_RECEIPT_INVALID"
  || error?.name === "AbortError" || error?.name === "TypeError"
  || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(error?.code)
  || String(error?.code || "").startsWith("UND_ERR_") || Number(error?.status) >= 500;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  const staff = await requireCapability(req, res, "editClients", "creating clients");
  if (!staff) return;

  let client;
  const allowBilling = memberHasCapability(staff.teamMember, "invoiceCreate");
  try {
    if (!isRecord(req.body) || Object.keys(req.body).some(key => key !== "client")) {
      return res.status(400).json({ ok: false, code: "client-create-request-invalid", error: "A new client profile is required." });
    }
    client = canonicalizeNewClientProfile(req.body.client, { allowBilling });
  } catch (error) {
    return res.status(Number(error.status) || 400).json({ ok: false, code: error.code || "client-create-profile-invalid", error: error.message });
  }

  const started = Date.now();
  let attempts = 0;
  let lastError;
  // This operation is append-only and keyed by its durable request identity.
  // One replay can confirm a lost response without reading/uploading the roster
  // and without duplicating the client or overwriting subsequent profile edits.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    attempts += 1;
    try {
      const row = await createClientRpc(client, allowBilling);
      return res.status(200).json(compactReceipt(row, client));
    } catch (error) {
      lastError = error;
      if (!transient(error) || attempt === 1) break;
    }
  }
  console.error("[client-create]", JSON.stringify({
    event: "request_failed", attempts, durationMs: Date.now() - started,
    code: String(lastError?.code || lastError?.name || "CLIENT_CREATE_ERROR").slice(0, 80),
  }));
  const conflictMessages = {
    client_create_request_mismatch: "An earlier save created this client with different details. Keep this form open and review the saved client before editing it.",
    client_create_identity_exists: "This client save identity is already in use. Reopen Add Client before saving.",
    client_create_identity_ambiguous: "The shared client list contains a duplicate identity and needs review before creating this client.",
    client_create_saved_client_missing: "This client's earlier creation is recorded, but its saved profile needs recovery. Keep this form open while the client list is reviewed.",
  };
  if (Object.hasOwn(conflictMessages, lastError?.code)) {
    return res.status(409).json({ ok: false, code: String(lastError.code).replaceAll("_", "-"), error: conflictMessages[lastError.code] });
  }
  if (["PGRST202", "CLIENT_CREATE_UNAVAILABLE", "client_create_service_only"].includes(lastError?.code)) {
    return res.status(503).json({ ok: false, code: "client-create-unavailable", retryable: true, commitState: "not-started", error: "The client save service is being updated. Your form is still here. Please retry Create Client shortly." });
  }
  if (lastError?.code === "client_create_billing_forbidden") {
    return res.status(403).json({ ok: false, code: "client-create-billing-forbidden", commitState: "not-started", error: "Creating clients with billing rates or automatic invoices requires billing access. Your form is still here." });
  }
  if (lastError?.code === "client_create_profile_too_large") {
    return res.status(413).json({ ok: false, code: "client-create-profile-too-large", commitState: "not-started", error: "This client profile is too large. Shorten its notes and try again. Your form is still here." });
  }
  // Only known input-validation failures belong to the form. Roster, version and
  // transaction-confirmation errors are server failures, even when named "invalid".
  if ([
    "client_create_identity_invalid", "client_create_name_invalid", "client_create_text_invalid",
    "client_create_boolean_invalid", "client_create_protected_field", "client_create_plan_invalid",
    "client_create_rate_invalid", "client_create_auto_invoice_invalid",
  ].includes(lastError?.code)) {
    return res.status(400).json({ ok: false, code: "client-create-profile-invalid", commitState: "not-started", error: "The client profile could not be accepted. Your form is still here. Check its details and try again." });
  }
  return res.status(503).json({ ok: false, code: "client-create-save-unconfirmed", retryable: true, commitState: "unconfirmed", error: "The server could not confirm this client yet. Your form is still here. Retry Create Client to check and finish the same save." });
}
