// Staff-authenticated live-location mutations.
//
// Browser GPS writes remain protected by staff_locations RLS. Privacy-critical shutdown uses this
// service-role bridge so sign-out can prove the exact active row is inactive before auth is removed.
// A caller may act only on the staff id bound to their current active team record.

import { requireStaff } from "./_staff-auth.js";

const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://ysqarusrewceezckawlo.supabase.co"
).replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function serviceHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
}

async function fetchWithin(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || 5000));
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!SERVICE_KEY) return res.status(503).json({ error: "Live-location service is unavailable." });

  const staff = await requireStaff(req, res, "live-location privacy controls");
  if (!staff) return;
  const ownStaffId = String(staff.teamMember?.id ?? "").trim();
  if (!ownStaffId) return res.status(403).json({ error: "Your team record has no valid staff identifier." });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (String(body.action || "").trim().toLowerCase() !== "deactivate") {
    return res.status(400).json({ error: "Unknown live-location action." });
  }
  const requestedStaffId = String(body.staffId ?? ownStaffId).trim();
  if (!requestedStaffId || requestedStaffId !== ownStaffId) {
    return res.status(403).json({ error: "You can stop only your own live-location session." });
  }

  const rowUrl = `${SUPABASE_URL}/rest/v1/staff_locations?staff_id=eq.${encodeURIComponent(ownStaffId)}`;
  try {
    const update = await fetchWithin(rowUrl, {
      method: "PATCH",
      headers: serviceHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
    });
    if (!update.ok) return res.status(502).json({ error: "Live location could not be stopped." });
    const changed = await update.json().catch(() => null);
    if (!Array.isArray(changed)) {
      return res.status(502).json({ error: "The server could not confirm that live location stopped." });
    }

    // Zero updated rows is safe only when the privileged verification read proves no row exists.
    // This distinguishes a genuinely absent location from an RLS/no-op response.
    if (changed.length === 0) {
      const verifyAbsent = await fetchWithin(`${rowUrl}&select=staff_id,is_active&limit=1`, {
        headers: serviceHeaders(),
      });
      if (!verifyAbsent.ok) return res.status(502).json({ error: "The server could not verify live-location privacy." });
      const existing = await verifyAbsent.json().catch(() => null);
      if (!Array.isArray(existing)) return res.status(502).json({ error: "The server could not verify live-location privacy." });
      if (existing.length === 0) return res.status(200).json({ ok: true, inactive: true, absent: true });
      if (existing.length === 1 && existing[0]?.is_active === false) {
        return res.status(200).json({ ok: true, inactive: true, alreadyInactive: true });
      }
      return res.status(502).json({ error: "Live location is still active. Please retry." });
    }

    const exact = changed.filter(row => String(row?.staff_id ?? "") === ownStaffId);
    if (exact.length !== changed.length || exact.some(row => row?.is_active !== false)) {
      return res.status(502).json({ error: "The server could not confirm that live location stopped." });
    }
    return res.status(200).json({ ok: true, inactive: true, updated: exact.length });
  } catch (_) {
    return res.status(502).json({ error: "Live location could not be stopped. Check your connection and retry." });
  }
}
