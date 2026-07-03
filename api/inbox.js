// api/inbox.js — the owner's work-email inbox, served to the app (Comms → Email).
//
// OWNER-ONLY on every verb (requireOwner — same fail-closed, API_AUTH_ENFORCED-independent
// posture as bank data): sps_inbox is the owner's PRIVATE mail, so it has no RLS read policy
// at all — the shared supabase client gets nothing, and this endpoint is the only door.
//
//   GET  ?limit=100&kind=lead&unimported=1   → { ok, rows: [...] } (newest first)
//   POST { action: "markRead", ids: [...] }
//   POST { action: "markImported", id, leadId }   ← the app stamps this AFTER the lead is
//        confirmed in sps_leads (two-phase, like the website bridge — a merge that never
//        persisted can't get acked)
//   POST { action: "setKind", id, kind }          ← owner reclassifies a mis-triaged email

// (In-app reply is a planned follow-up — message_id is already stored for threading.)

import { requireOwner } from "./plaid/_plaid.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!SERVICE_KEY) return res.status(501).json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });

  const u = await requireOwner(req, res, "the email inbox");
  if (!u) return;

  try {
    if (req.method === "GET") {
      const q = req.query || {};
      const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 100));
      let filter = `order=created_at.desc&limit=${limit}`;
      if (q.kind && /^[a-z]+$/.test(String(q.kind))) filter += `&kind=eq.${q.kind}`;
      if (q.unimported === "1") filter += `&lead_id=eq.`;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?select=*&${filter}`, { headers: sbHeaders() });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        const hint = /relation .*sps_inbox|42P01/i.test(t) ? "The sps_inbox table hasn't been created yet — run the SQL in CLAUDE.md." : t.slice(0, 200);
        return res.status(502).json({ error: hint });
      }
      return res.status(200).json({ ok: true, rows: (await r.json().catch(() => [])) || [] });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
    const b = req.body || {};
    const patch = async (idFilter, fields) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?${idFilter}`, {
        method: "PATCH", headers: sbHeaders(), body: JSON.stringify(fields),
      });
      return r.ok;
    };
    if (b.action === "markRead") {
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean).slice(0, 200);
      if (!ids.length) return res.status(400).json({ error: "No ids." });
      const ok = await patch(`id=in.(${ids.map(encodeURIComponent).join(",")})`, { read: true });
      return res.status(ok ? 200 : 502).json({ ok });
    }
    if (b.action === "markImported") {
      if (!b.id || !b.leadId) return res.status(400).json({ error: "Need id + leadId." });
      const ok = await patch(`id=eq.${encodeURIComponent(String(b.id))}`, { lead_id: String(b.leadId) });
      return res.status(ok ? 200 : 502).json({ ok });
    }
    if (b.action === "setKind") {
      if (!b.id || !["lead", "bill", "client", "other"].includes(b.kind)) return res.status(400).json({ error: "Need id + a valid kind." });
      const ok = await patch(`id=eq.${encodeURIComponent(String(b.id))}`, { kind: b.kind });
      return res.status(ok ? 200 : 502).json({ ok });
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
