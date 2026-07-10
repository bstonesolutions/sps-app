// api/plaid/_plaid.js  (underscore-prefixed → shared helper, not an HTTP route)
// Server-side Plaid client + token store. The owner links their bank through Plaid Link (the app never
// sees bank credentials); we store only the item access_token in the plaid_tokens table (SERVICE_ROLE,
// never reaches the client) — same posture as qb_tokens. Everything is gated so the feature ships DARK
// until PLAID_CLIENT_ID + PLAID_SECRET are set in Vercel.
//
// Required env: PLAID_CLIENT_ID, PLAID_SECRET, SUPABASE_SERVICE_ROLE_KEY
// Optional env: PLAID_ENV (sandbox | production; default sandbox), SUPABASE_URL

import { verifyUser } from "../_auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT_ID    = process.env.PLAID_CLIENT_ID;
const SECRET       = process.env.PLAID_SECRET;
export const PLAID_ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const HOSTS = { sandbox: "https://sandbox.plaid.com", development: "https://development.plaid.com", production: "https://production.plaid.com" };
export const PLAID_HOST = HOSTS[PLAID_ENV] || HOSTS.sandbox;
const ROW_ID = "default"; // single-business app → one linked item row

export const plaidConfigured = () => !!(CLIENT_ID && SECRET);

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// One Plaid API call. Injects client_id + secret server-side. Throws { plaid, status } on error.
export async function plaidCall(path, body) {
  if (!plaidConfigured()) { const e = new Error("Plaid not configured"); e.missingEnv = true; throw e; }
  const r = await fetch(`${PLAID_HOST}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, secret: SECRET, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error_message || `Plaid error ${r.status}`); e.plaid = data; e.status = r.status; throw e; }
  return data;
}

// ── token store (Supabase REST, service-role) ────────────────────────────────────────────────────
const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
export async function getItem() {
  if (!SERVICE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/plaid_tokens?id=eq.${ROW_ID}&select=*`, { headers: sbHeaders() });
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    return rows && rows[0] ? rows[0] : null;
  } catch { return null; }
}
export async function saveItem({ access_token, item_id, institution }) {
  if (!SERVICE_KEY) throw new Error("Server missing SUPABASE_SERVICE_ROLE_KEY");
  const row = { id: ROW_ID, access_token, item_id, institution: institution || null, updated_at: new Date().toISOString() };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/plaid_tokens?on_conflict=id`, {
    method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error("Token store write failed: " + (await r.text().catch(() => String(r.status))));
}
export async function clearItem() {
  if (!SERVICE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/plaid_tokens?id=eq.${ROW_ID}`, { method: "DELETE", headers: sbHeaders() });
}

// The owner's per-account include list, chosen in the app's Bank Sync picker and stored in app_state
// under key `sps_plaid_sel` = { enabled: [account_id, ...] }. One bank login (e.g. Truist) can expose
// several accounts (business + personal) under one Plaid item; this lets the owner feed only the ones
// they want into the Budget/Home/Reports/digest numbers. Empty/unset → include ALL accounts (backward
// compatible). Returns a Set of account_ids to KEEP, or null for "all". Best-effort: any read hiccup
// falls back to all so the money tiles never silently blank out. Read-only app_state — no schema touch.
export async function enabledAccountSet() {
  if (!SERVICE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.sps_plaid_sel&select=value`, { headers: sbHeaders() });
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    let v = rows && rows[0] ? rows[0].value : null;
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
    const ids = v && Array.isArray(v.enabled) ? v.enabled.map(String).filter(Boolean) : [];
    return ids.length ? new Set(ids) : null;
  } catch { return null; }
}

// Filter a raw Plaid /transactions/get list down to the owner-selected accounts (no-op when "all").
export function filterByAccounts(rawTxns, keepSet) {
  return keepSet ? (rawTxns || []).filter((t) => keepSet.has(String(t.account_id))) : (rawTxns || []);
}

// ── owner-only gate ───────────────────────────────────────────────────────────────────────────────
// Bank transactions are at least as sensitive as the owner financial digest, so the data endpoints
// (link/exchange/transactions/disconnect) are OWNER-ONLY — a signed-in staff tech must not be able to
// pull the owner's bank history by hitting the endpoint directly (the Budget UI is gated, but the API
// is reachable). We mirror owner-digest.js exactly and, like it, verify INDEPENDENTLY of
// API_AUTH_ENFORCED: resolve the owner email(s) from app_state and require the caller's VERIFIED
// Supabase email to match. Fail closed — deny when the caller has no verified email or no owner
// identity is configured yet. On failure it sends the response and returns null (handler must return).
const parseVal = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
async function sbGet(key, fallback) {
  if (!SERVICE_KEY) return fallback;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
    if (!r.ok) return fallback;
    const rows = await r.json().catch(() => []);
    const v = rows && rows[0] ? parseVal(rows[0].value) : null;
    return v == null ? fallback : v;
  } catch { return fallback; }
}
export async function requireOwner(req, res, feature = "bank sync") {
  const u = await verifyUser(req);
  const callerEmail = String((u && u.email) || "").toLowerCase();
  const [team, branding, email] = await Promise.all([sbGet("sps_team", []), sbGet("sps_branding", {}), sbGet("sps_email", {})]);
  const ownerEmails = [((team || []).find((m) => m && m.role === "owner") || {}).email, branding.companyEmail, email.ownerEmail]
    .filter(Boolean).map((e) => String(e).toLowerCase());
  if (!callerEmail || ownerEmails.length === 0 || !ownerEmails.includes(callerEmail)) {
    res.status(403).json({ error: `Owner only. Sign in as the owner (and set a company or owner email in settings) to use ${feature}.` });
    return null;
  }
  return u;
}
