// api/push/register.js — bind this device's APNs token to the signed-in user.
//
// POST {token, remove?} with the app's Supabase session token. Identity is derived ENTIRELY
// server-side from the VERIFIED auth identity (never from request-body claims):
//   email ∈ sps_team           → role from the team record ("owner" | "staff"), user_key = member id
//   email ∈ sps_clients        → "client", user_key = client id
// Rows upsert into sps_push_tokens (service-role only — see CLAUDE.md SQL). {remove:true}
// deletes the token (sign-out / toggle off). GET ?check → configured booleans only.

import { verifyUser } from "../_auth.js";
import { resolveStaffUser } from "../_staff-auth.js";
import { resolvePortalClient } from "../_portal-auth.js";
import { getUserPushStatus, pushConfigured, pushUserSelfTest } from "../_push.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const parseVal = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
const cleanInstallId = (value) => {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._~-]{16,128}$/.test(id) ? id : "";
};
async function fetchWithin(url, options = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(100, Number(timeoutMs) || 5000));
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}
async function sbGet(key, fallback) {
  try {
    const r = await fetchWithin(`${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() }, 4500);
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

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const action = String(body.action || "").trim().toLowerCase();
  const emailKey = String(user.email).trim().toLowerCase();
  const rawInstallId = String(body.installId || "").trim();
  const installId = cleanInstallId(rawInstallId);
  if (rawInstallId && !installId) return res.status(400).json({ error: "Invalid notification install identifier." });
  const platform = installId ? `ios:${installId}` : "ios";

  if (action === "status") {
    try {
      // Deliberately return no token, role, user key, or email. The query is scoped solely from
      // the verified Supabase identity above; request-body identity claims are ignored.
      const status = await getUserPushStatus(emailKey, { platform: installId ? platform : "" });
      return res.status(200).json(status);
    } catch (error) {
      console.error("[push/register] status lookup failed:", error && error.message ? error.message : error);
      return res.status(502).json({ error: "Notification registration status is temporarily unavailable." });
    }
  }

  if (action === "test") {
    const result = await pushUserSelfTest(emailKey, { platform: installId ? platform : "" });
    if (result && result.reason === "no registered devices") {
      return res.status(409).json({ ok: false, sent: 0, error: "No enabled notification device is registered for this account." });
    }
    if (result && result.skipped === "apns not configured") {
      return res.status(503).json({ ok: false, sent: 0, error: "Apple notifications are not configured on the server yet." });
    }
    if (!result || result.ok !== true) {
      console.error("[push/register] self-test failed:", result && result.error ? result.error : "unknown APNs error");
      return res.status(502).json({
        ok: false,
        sent: Number((result && result.sent) || 0),
        failed: Number((result && result.failed) || 0),
        pruned: Number((result && result.pruned) || 0),
        error: "The test notification could not be delivered. Try registering this device again.",
      });
    }
    return res.status(200).json({
      ok: true,
      sent: Number(result.sent || 0),
      failed: Number(result.failed || 0),
      pruned: Number(result.pruned || 0),
    });
  }

  if (action === "unregister") {
    if (!installId) return res.status(400).json({ ok: false, removed: false, removedCount: 0, error: "A valid notification install identifier is required." });
    try {
      // Cold-launch sign-out cannot rely on the APNs token still being held in JavaScript memory.
      // The stable install id lets the verified account unlink every stale/current token for this
      // one physical install without touching another device owned by the same account.
      const removal = await fetchWithin(
        `${SUPABASE_URL}/rest/v1/sps_push_tokens?user_email=eq.${encodeURIComponent(emailKey)}&platform=eq.${encodeURIComponent(platform)}`,
        { method: "DELETE", headers: { ...sbHeaders(), Prefer: "return=representation" } },
        5000,
      );
      if (!removal.ok) return res.status(502).json({ ok: false, removed: false, removedCount: 0, error: "Couldn't unlink this notification device." });
      const rows = await removal.json().catch(() => null);
      if (!Array.isArray(rows)) return res.status(502).json({ ok: false, removed: false, removedCount: 0, error: "Couldn't confirm that this notification device was unlinked." });
      return res.status(200).json({ ok: true, removed: rows.length > 0, removedCount: rows.length });
    } catch (_) {
      return res.status(502).json({ ok: false, removed: false, removedCount: 0, error: "Couldn't unlink this notification device." });
    }
  }

  if (action && action !== "register") return res.status(400).json({ error: "Unknown notification action." });

  const token = String(body.token || "").trim();
  if (!/^[0-9a-f]{32,200}$/i.test(token)) return res.status(400).json({ error: "That doesn't look like a device token." });

  if (body.remove) {
    try {
      // A signed-in user may unregister only a token currently bound to their own verified email.
      // The token alone is not treated as authorization.
      const removal = await fetchWithin(
        `${SUPABASE_URL}/rest/v1/sps_push_tokens?token=eq.${encodeURIComponent(token)}&user_email=eq.${encodeURIComponent(emailKey)}${installId ? `&platform=eq.${encodeURIComponent(platform)}` : ""}`,
        { method: "DELETE", headers: { ...sbHeaders(), Prefer: "return=representation" } },
        5000,
      );
      if (!removal.ok) return res.status(502).json({ ok: false, removed: false, error: "Couldn't unlink this notification device." });
      const rows = await removal.json().catch(() => null);
      if (!Array.isArray(rows)) return res.status(502).json({ ok: false, removed: false, error: "Couldn't confirm that this notification device was unlinked." });
      return res.status(200).json({ ok: true, removed: rows.length > 0 });
    } catch (_) {
      return res.status(502).json({ ok: false, removed: false, error: "Couldn't unlink this notification device." });
    }
  }

  // Resolve the verified identity through the same fail-closed roster/client rules as every other
  // privileged/portal route. Disabled or duplicate team rows and ambiguous client emails are denied.
  let role = "", userKey = "";
  let staff = null;
  try { staff = await resolveStaffUser(user); } catch (_) { return res.status(503).json({ error: "Authorization is temporarily unavailable." }); }
  if (staff) {
    role = staff.teamRole === "owner" ? "owner" : "staff";
    userKey = String((staff.teamMember && staff.teamMember.id) || emailKey);
  } else {
    const clients = await sbGet("sps_clients", []);
    const resolved = resolvePortalClient(clients, user);
    if (resolved.client) { role = "client"; userKey = String(resolved.client.id); }
  }
  if (!role) return res.status(403).json({ error: "This account isn't on the team or client list. (Owners: make sure your login email is on your own Team list.)" });

  const row = { token, user_email: emailKey, user_key: userKey, role, platform, enabled: true, updated_at: new Date().toISOString() };
  try {
    const r = await fetchWithin(`${SUPABASE_URL}/rest/v1/sps_push_tokens?on_conflict=token`, {
      method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([row]),
    }, 5000);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      const hint = /relation .*sps_push_tokens.* does not exist|42P01/i.test(t)
        ? "The sps_push_tokens table hasn't been created yet — run the SQL in CLAUDE.md."
        : t.slice(0, 200);
      return res.status(502).json({ error: `Couldn't save the device token. ${hint}` });
    }
    // APNs can rotate a token for one physical install. Once the new token is safely stored, prune
    // older rows for this exact verified account/install so readiness and self-tests stay current.
    if (installId) {
      try {
        const cleanup = await fetchWithin(
          `${SUPABASE_URL}/rest/v1/sps_push_tokens?user_email=eq.${encodeURIComponent(emailKey)}&platform=eq.${encodeURIComponent(platform)}&token=neq.${encodeURIComponent(token)}`,
          { method: "DELETE", headers: sbHeaders() },
          2500,
        );
        if (!cleanup.ok) console.warn("[push/register] stale-token cleanup failed", cleanup.status);
      } catch (_) { /* best-effort stale-token cleanup; the new binding is already durable */ }
    }
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
  return res.status(200).json({ ok: true, role, configured: { apns: pushConfigured() } });
}
