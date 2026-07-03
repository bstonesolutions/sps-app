// api/push/register.js — bind this device's APNs token to the signed-in user.
//
// POST {token, remove?} with the app's Supabase session token. Identity is derived ENTIRELY
// server-side from the VERIFIED auth email (never from request-body claims — requireUser is
// fail-open until API_AUTH_ENFORCED, so body claims can't be trusted):
//   email ∈ sps_team           → role from the team record ("owner" | "staff"), user_key = member id
//   email = owner-chain email  → "owner" (covers an owner not present in sps_team)
//   email ∈ sps_clients        → "client", user_key = client id
// Rows upsert into sps_push_tokens (service-role only — see CLAUDE.md SQL). {remove:true}
// deletes the token (sign-out / toggle off). GET ?check → configured booleans only.

import { verifyUser } from "../_auth.js";
import { pushConfigured } from "../_push.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const parseVal = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
async function sbGet(key, fallback) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
    if (!r.ok) return fallback;
    const rows = await r.json().catch(() => []);
    const v = rows && rows[0] ? parseVal(rows[0].value) : null;
    return v == null ? fallback : v;
  } catch { return fallback; }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, configured: { apns: pushConfigured() } });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!SERVICE_KEY) return res.status(501).json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });

  const user = await verifyUser(req);
  if (!user || !user.email) return res.status(401).json({ error: "Please sign in again to enable notifications." });

  const token = String((req.body && req.body.token) || "").trim();
  if (!/^[0-9a-f]{32,200}$/i.test(token)) return res.status(400).json({ error: "That doesn't look like a device token." });

  if (req.body && req.body.remove) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/sps_push_tokens?token=eq.${encodeURIComponent(token)}`, { method: "DELETE", headers: sbHeaders() });
    } catch (_) { /* best-effort */ }
    return res.status(200).json({ ok: true, removed: true });
  }

  // Resolve who this verified email is. OWNER comes ONLY from the sps_team record — never
  // from the branding/sps_email owner-email chain, because app_state is writable by any
  // authenticated user until the RLS lock lands: a client who wrote their own email into
  // sps_email.notify.ownerEmail must NOT be able to register an owner-role device (owner
  // pushes include the money plan with bank balances).
  const emailKey = String(user.email).trim().toLowerCase();
  const team = await sbGet("sps_team", []);
  const member = (Array.isArray(team) ? team : []).find(m => String(m.email || "").trim().toLowerCase() === emailKey);
  let role = "", userKey = "";
  if (member) {
    role = member.role === "owner" ? "owner" : "staff";
    userKey = String(member.id || emailKey);
  } else {
    const clients = await sbGet("sps_clients", []);
    const client = (Array.isArray(clients) ? clients : []).find(c => String(c.email || "").trim().toLowerCase() === emailKey);
    if (client) { role = "client"; userKey = String(client.id); }
  }
  if (!role) return res.status(403).json({ error: "This account isn't on the team or client list. (Owners: make sure your login email is on your own Team list.)" });

  const row = { token, user_email: emailKey, user_key: userKey, role, platform: "ios", enabled: true, updated_at: new Date().toISOString() };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_push_tokens?on_conflict=token`, {
      method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([row]),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      const hint = /relation .*sps_push_tokens.* does not exist|42P01/i.test(t)
        ? "The sps_push_tokens table hasn't been created yet — run the SQL in CLAUDE.md."
        : t.slice(0, 200);
      return res.status(502).json({ error: `Couldn't save the device token. ${hint}` });
    }
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
  return res.status(200).json({ ok: true, role, configured: { apns: pushConfigured() } });
}
