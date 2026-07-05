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
//        original, with a copy dropped into the owner's real Gmail "Sent" over IMAP
//        (api/_gmail.js appendToGmailSent — best-effort; replaces the old inbox BCC).

import { requireOwner } from "./plaid/_plaid.js";
import { resolveFrom } from "./_sender.js";
import { appendToGmailSent } from "./_gmail.js";

// Sending also drops a copy into Gmail "Sent" over IMAP — give the function room for that round-trip.
export const config = { maxDuration: 30 };

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
// Shared email look + helpers for send/reply. The rich composer sends real HTML (bold/italic/
// lists/links); strip only scripts/styles (the owner authors it, so this is a light guard).
const EMAIL_FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#111827;line-height:1.6";
const stripHtml = (h) => String(h || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").slice(0, 300000);
const sigHtml = (sig) => sig ? `<br><br>${escapeHtml(sig).replace(/\n/g, "<br>")}` : "";
// Build the html part: use the composer's HTML when present, else pre-wrap the plain text.
const emailHtml = (htmlIn, textOut, sig) => htmlIn
  ? `<div style="${EMAIL_FONT}">${htmlIn}${sigHtml(sig)}</div>`
  : `<div style="${EMAIL_FONT};white-space:pre-wrap">${escapeHtml(textOut)}</div>`;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Composer attachments → Resend format ([{ filename, content(base64) }]). Hard-capped: Vercel's
// request body is ~4.5MB, so we bound total base64 well under that and keep headroom for the message.
const cleanAttachments = (arr) => {
  const out = [];
  let total = 0;
  for (const a of (Array.isArray(arr) ? arr : []).slice(0, 5)) {
    const content = String((a && a.content) || "");
    if (!content) continue;
    total += content.length;
    if (total > 4_000_000) break; // ~3MB of raw bytes across all files — a backstop below Vercel's ~4.5MB body limit
    out.push({ filename: String((a && a.filename) || "attachment").replace(/[\r\n"\\]+/g, " ").slice(0, 200), content });
  }
  return out;
};

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
      // Accepts a single id or a batch of ids (bulk reclassify from the inbox select mode).
      const ids = (Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : [])).map(String).filter(Boolean).slice(0, 200);
      if (!ids.length || !["lead", "bill", "client", "other"].includes(b.kind)) return res.status(400).json({ error: "Need id(s) + a valid kind." });
      const ok = await patch(`id=in.(${ids.map(encodeURIComponent).join(",")})`, { kind: b.kind });
      return res.status(ok ? 200 : 502).json({ ok });
    }
    if (b.action === "delete") {
      // Owner deletes mail from their own inbox (single or bulk). Hard delete — sps_inbox is the
      // system of record, so there's no soft-delete; the UI confirms before calling this.
      const ids = (Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : [])).map(String).filter(Boolean).slice(0, 200);
      if (!ids.length) return res.status(400).json({ error: "No ids." });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=in.(${ids.map(encodeURIComponent).join(",")})`, { method: "DELETE", headers: sbHeaders() });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, deleted: r.ok ? ids.length : 0 });
    }
    if (b.action === "reply") {
      if (!RESEND_KEY) return res.status(501).json({ error: "Email sending isn't configured (RESEND_API_KEY).", missingEnv: true });
      const replyBody = String(b.body || "").trim().slice(0, 10000);
      if (!b.id || !replyBody) return res.status(400).json({ error: "Need id + a reply body." });
      // Load the original for the address, subject, and threading id.
      const rr = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(String(b.id))}&select=from_email,from_name,subject,message_id`, { headers: sbHeaders() });
      const orig = ((await rr.json().catch(() => [])) || [])[0];
      if (!orig || !orig.from_email) return res.status(404).json({ error: "That email isn't in the inbox anymore." });
      // Defense in depth: SMS rows store a formatted phone in from_email — never try to email
      // that. The UI hides email-reply for texts (shows "Text back"), but guard the API too.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(orig.from_email).trim())) {
        return res.status(400).json({ error: "This is a text message — reply with “Text back,” not email." });
      }
      // FROM = the configured Sending Identity (Comms → Settings) on the verified domain — same canon
      // as every other send. The sent copy lands in the owner's real Gmail "Sent" over IMAP below
      // (no BCC — that used to drop a copy into the Inbox instead, which just cluttered it).
      const email = await sbGet("sps_email", {});
      const from = resolveFrom({ fromName: email.fromName, fromAddress: email.fromAddress }, process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>");
      const sig = String(email.signature || "").trim();
      const bodyOut = replyBody + (sig ? `\n\n${sig}` : "");
      const htmlIn = b.html ? stripHtml(b.html) : "";
      const subject = /^re:/i.test(orig.subject || "") ? orig.subject : `Re: ${orig.subject || ""}`.trim();
      const atts = cleanAttachments(b.attachments);
      const replyHtmlOut = emailHtml(htmlIn, bodyOut, sig);
      const sr = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to: [orig.from_email], subject,
          text: bodyOut,
          html: replyHtmlOut,
          ...(atts.length ? { attachments: atts } : {}),
          ...(orig.message_id ? { headers: { "In-Reply-To": orig.message_id, References: orig.message_id } } : {}),
        }),
      });
      const sd = await sr.json().catch(() => ({}));
      if (!sr.ok) return res.status(502).json({ error: sd?.message || `Resend ${sr.status}` });
      // Drop the sent copy into the owner's real Gmail "Sent" (and Apple Mail), threaded to the
      // original. Best-effort — the reply already went out; never fail the request on this.
      try { await appendToGmailSent({ from, to: orig.from_email, subject, html: replyHtmlOut, text: bodyOut, inReplyTo: orig.message_id || undefined, references: orig.message_id || undefined }); } catch (_) {}
      await patch(`id=eq.${encodeURIComponent(String(b.id))}`, { replied: true }).catch(() => {});
      // Comms → Log entry (outbound record, like any other send). Legacy-shape fallback for
      // installs that haven't added the origin/recipient columns yet.
      try {
        const base = { client_id: "", type: "Email reply", channel: "email", body: `${subject} — ${replyBody.slice(0, 600)}`, ok: true };
        const lr = await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, {
          method: "POST", headers: sbHeaders(),
          body: JSON.stringify({ ...base, origin: "work-email reply (Comms → Email)", recipient: orig.from_email }),
        });
        if (lr.status === 400 && /column/i.test(await lr.text().catch(() => ""))) {
          await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, { method: "POST", headers: sbHeaders(), body: JSON.stringify(base) });
        }
      } catch { /* best-effort */ }
      return res.status(200).json({ ok: true, id: sd.id || null });
    }
    if (b.action === "send") {
      // Compose a brand-new email from the app (Comms → Email → Compose). Same send canon as reply:
      // FROM the Sending Identity, signature appended, and the sent copy dropped into Gmail "Sent".
      if (!RESEND_KEY) return res.status(501).json({ error: "Email sending isn't configured (RESEND_API_KEY).", missingEnv: true });
      const to = String(b.to || "").trim();
      const subject = String(b.subject || "").trim().slice(0, 300);
      const bodyIn = String(b.body || "").trim().slice(0, 10000);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Enter a valid recipient email address." });
      if (!bodyIn) return res.status(400).json({ error: "Write a message first." });
      const email = await sbGet("sps_email", {});
      const from = resolveFrom({ fromName: email.fromName, fromAddress: email.fromAddress }, process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>");
      const sig = String(email.signature || "").trim();
      const bodyOut = bodyIn + (sig ? `\n\n${sig}` : "");
      const htmlIn = b.html ? stripHtml(b.html) : "";
      const atts = cleanAttachments(b.attachments);
      const sendHtmlOut = emailHtml(htmlIn, bodyOut, sig);
      const sr = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to: [to], subject: subject || "(no subject)",
          text: bodyOut,
          html: sendHtmlOut,
          ...(atts.length ? { attachments: atts } : {}),
        }),
      });
      const sd = await sr.json().catch(() => ({}));
      if (!sr.ok) return res.status(502).json({ error: sd?.message || `Resend ${sr.status}` });
      // Land the sent copy in the owner's real Gmail "Sent" (and Apple Mail). Best-effort.
      try { await appendToGmailSent({ from, to, subject: subject || "(no subject)", html: sendHtmlOut, text: bodyOut }); } catch (_) {}
      try {
        const base = { client_id: "", type: "Email sent", channel: "email", body: `${subject || "(no subject)"} — ${bodyIn.slice(0, 600)}`, ok: true };
        const lr = await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, { method: "POST", headers: sbHeaders(), body: JSON.stringify({ ...base, origin: "work-email compose (Comms → Email)", recipient: to }) });
        if (lr.status === 400 && /column/i.test(await lr.text().catch(() => ""))) {
          await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, { method: "POST", headers: sbHeaders(), body: JSON.stringify(base) });
        }
      } catch { /* best-effort */ }
      return res.status(200).json({ ok: true, id: sd.id || null });
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
