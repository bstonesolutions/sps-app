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

//   POST { action: "reply", id, body }            ← send a real reply via Resend, FROM the
//        configured Sending Identity (Comms → Settings), threaded (In-Reply-To) onto the
//        original, BCC'd to the owner so Gmail keeps a record (inbound-email.js loop-guards
//        that copy so it never re-ingests).

import { requireOwner } from "./plaid/_plaid.js";
import { resolveFrom } from "./_sender.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
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
const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
      // b.read: true (default) or false — same action handles "mark unread".
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean).slice(0, 200);
      if (!ids.length) return res.status(400).json({ error: "No ids." });
      const ok = await patch(`id=in.(${ids.map(encodeURIComponent).join(",")})`, { read: b.read !== false });
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
    if (b.action === "reply") {
      if (!RESEND_KEY) return res.status(501).json({ error: "Email sending isn't configured (RESEND_API_KEY).", missingEnv: true });
      const replyBody = String(b.body || "").trim().slice(0, 10000);
      if (!b.id || !replyBody) return res.status(400).json({ error: "Need id + a reply body." });
      // Load the original for the address, subject, and threading id.
      const rr = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(String(b.id))}&select=from_email,from_name,subject,message_id`, { headers: sbHeaders() });
      const orig = ((await rr.json().catch(() => [])) || [])[0];
      if (!orig || !orig.from_email) return res.status(404).json({ error: "That email isn't in the inbox anymore." });
      // FROM = the configured Sending Identity (Comms → Settings) on the verified domain —
      // same canon as every other send. BCC the owner so Gmail keeps the record (the inbound
      // loop guard skips that copy when Gmail forwards it back).
      const email = await sbGet("sps_email", {});
      const from = resolveFrom({ fromName: email.fromName, fromAddress: email.fromAddress }, process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>");
      const bcc = [email.notify && email.notify.ownerEmail, email.ownerEmail].map(e => String(e || "").trim()).find(e => /.+@.+\..+/.test(e));
      const subject = /^re:/i.test(orig.subject || "") ? orig.subject : `Re: ${orig.subject || ""}`.trim();
      const sr = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to: [orig.from_email], subject,
          text: replyBody,
          html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#111827;line-height:1.6;white-space:pre-wrap">${escapeHtml(replyBody)}</div>`,
          ...(bcc ? { bcc: [bcc] } : {}),
          ...(orig.message_id ? { headers: { "In-Reply-To": orig.message_id, References: orig.message_id } } : {}),
        }),
      });
      const sd = await sr.json().catch(() => ({}));
      if (!sr.ok) return res.status(502).json({ error: sd?.message || `Resend ${sr.status}` });
      await patch(`id=eq.${encodeURIComponent(String(b.id))}`, { replied: true }).catch(() => {});
      // Comms → Log entry (outbound record, like any other send).
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, {
          method: "POST", headers: sbHeaders(),
          body: JSON.stringify({ client_id: "", type: "Email reply", channel: "email", body: `${subject} — ${replyBody.slice(0, 600)}`, ok: true, origin: "work-email reply (Comms → Email)", recipient: orig.from_email }),
        });
      } catch { /* best-effort */ }
      return res.status(200).json({ ok: true, id: sd.id || null });
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
