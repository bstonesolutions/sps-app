// api/quickbooks/qb-store.js
// Server-side QuickBooks token store + helpers. Tokens live in the qb_tokens table
// (one row — single business) and never reach the client. getValidAccessToken()
// transparently refreshes an expired access token before each API call, so the
// app just calls the endpoints with no tokens of its own.
//
// Required env: SUPABASE_SERVICE_ROLE_KEY, QB_CLIENT_ID, QB_CLIENT_SECRET
// Optional env:
//   SUPABASE_URL  - defaults to the known project URL
//   QB_API_BASE   - QuickBooks API origin. Defaults to PRODUCTION
//                   (https://quickbooks.api.intuit.com). Set to
//                   https://sandbox-quickbooks.api.intuit.com for the Intuit sandbox.
//
// NOTE: this is a helper module, not an HTTP route (no default export).

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const QB_API_BASE = process.env.QB_API_BASE || "https://quickbooks.api.intuit.com";
const ROW_ID = "default"; // single-business app → one token row

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  // Authorization is required: native (capacitor://localhost) calls these endpoints cross-origin and
  // attaches a Bearer token, which forces a CORS preflight. Omitting it here makes the browser block
  // every authenticated QB call (sync, create/update-invoice) on native while same-origin web works.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const sbHeaders = () => ({
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
});

export async function getTokens() {
  if (!SERVICE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/qb_tokens?id=eq.${ROW_ID}&select=*`, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return rows && rows[0] ? rows[0] : null;
}

export async function saveTokens({ realm_id, access_token, refresh_token, expires_in }) {
  if (!SERVICE_KEY) throw new Error("Server missing SUPABASE_SERVICE_ROLE_KEY");
  const expires_at = new Date(Date.now() + (Number(expires_in) || 3600) * 1000).toISOString();
  const row = { id: ROW_ID, realm_id, access_token, refresh_token, expires_at, updated_at: new Date().toISOString() };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/qb_tokens?on_conflict=id`, {
    method: "POST",
    headers: { ...sbHeaders(), "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error("Token store write failed: " + (await r.text().catch(() => String(r.status))));
}

export async function clearTokens() {
  if (!SERVICE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/qb_tokens?id=eq.${ROW_ID}`, { method: "DELETE", headers: sbHeaders() });
}

async function refreshAccess(refresh_token) {
  const clientId = process.env.QB_CLIENT_ID, clientSecret = process.env.QB_CLIENT_SECRET;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }).toString(),
  });
  if (!r.ok) { const e = new Error("refresh_failed"); e.reconnect = true; throw e; }
  return r.json();
}

// Returns { access_token, realm_id }, refreshing + persisting if within ~2 min of
// expiry. Throws an error with .reconnect = true when there's nothing usable, so
// callers can surface a "reconnect QuickBooks" message.
export async function getValidAccessToken() {
  const t = await getTokens();
  if (!t || !t.access_token || !t.realm_id) { const e = new Error("not_connected"); e.reconnect = true; throw e; }
  const expMs = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  if (expMs - Date.now() > 120000) return { access_token: t.access_token, realm_id: t.realm_id };
  if (!t.refresh_token) { const e = new Error("not_connected"); e.reconnect = true; throw e; }
  const fresh = await refreshAccess(t.refresh_token);
  await saveTokens({
    realm_id: t.realm_id,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || t.refresh_token, // QB rotates refresh tokens
    expires_in: fresh.expires_in,
  });
  return { access_token: fresh.access_token, realm_id: t.realm_id };
}
