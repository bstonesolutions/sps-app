// api/gmail-action.js — apply an action taken in the app's inbox to the REAL Gmail mailbox over
// IMAP, so Comms → Email becomes a true two-way client (and Apple Mail, which mirrors the same
// Gmail, updates for free). Reuses the same app-password IMAP setup as gmail-backfill.js.
//
//   POST { action: "markRead" | "markUnread", ids: [...] }   (Phase 2)
//   POST { action: "trash", ids: [...] }                     (Phase 3 — move to Gmail Trash)
//
// SAFETY (this touches real mail, so it is fail-closed toward doing NOTHING in Gmail):
//   • Owner-only (requireOwner — same posture as gmail-backfill / bank data).
//   • Each app row is matched to the real message by its RFC Message-ID via Gmail's rfc822msgid:
//     search. We act ONLY when the search returns EXACTLY ONE message — Message-IDs are globally
//     unique, so a wrong-message hit is effectively impossible. 0 hits or anything ambiguous →
//     the id is reported in `skipped` and Gmail is left untouched (the app's local state still
//     changed, exactly like before two-way sync).
//   • DELETE is a MOVE TO TRASH (recoverable ~30 days), never an expunge/permanent delete.
//   • SMS rows (channel='sms') have no IMAP counterpart → always skipped.
// Ships dark until GMAIL_IMAP_USER + GMAIL_IMAP_PASSWORD are set.

import { ImapFlow } from "imapflow";
import { requireOwner } from "./plaid/_plaid.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IMAP_USER    = process.env.GMAIL_IMAP_USER;
const IMAP_PASS    = process.env.GMAIL_IMAP_PASSWORD;

export const config = { maxDuration: 60 };

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const norm = (mid) => String(mid || "").trim().replace(/^<+|>+$/g, ""); // Message-ID without angle brackets

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Resolve a Gmail special-use mailbox (localized names vary) by its RFC 6154 flag, e.g. "\\All",
// "\\Trash". Falls back to the common English path if the flag isn't advertised.
async function findBox(client, useFlag, fallback) {
  try {
    const boxes = await client.list();
    const hit = (boxes || []).find(b => b.specialUse === useFlag);
    return (hit && hit.path) || fallback;
  } catch { return fallback; }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, configured: { imap: !!(IMAP_USER && IMAP_PASS) } });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!SERVICE_KEY) return res.status(501).json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });

  const u = await requireOwner(req, res, "email actions");
  if (!u) return;
  if (!IMAP_USER || !IMAP_PASS) return res.status(501).json({ error: "Gmail two-way sync isn't set up — add GMAIL_IMAP_USER and GMAIL_IMAP_PASSWORD in Vercel.", missingEnv: true });

  const b = req.body || {};
  const action = String(b.action || "");
  if (!["markRead", "markUnread", "trash"].includes(action)) return res.status(400).json({ error: "Unknown action." });
  const ids = (Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : [])).map(String).filter(Boolean).slice(0, 50);
  if (!ids.length) return res.status(400).json({ error: "No ids." });

  // Load the match keys for these rows (Message-ID; forwarded rows may carry an original_message_id).
  let rows = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=in.(${ids.map(encodeURIComponent).join(",")})&select=id,message_id,original_message_id,channel,from_email,subject`, { headers: sbHeaders() });
    if (r.ok) rows = (await r.json().catch(() => [])) || [];
  } catch (_) { /* fall through — everything becomes "skipped" */ }
  const byId = new Map(rows.map(r => [String(r.id), r]));

  const updated = [], skipped = [];
  let client;
  try {
    client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
    await client.connect();
    const allMail = await findBox(client, "\\All", "[Gmail]/All Mail");
    const trash   = action === "trash" ? await findBox(client, "\\Trash", "[Gmail]/Trash") : null;
    const lock = await client.getMailboxLock(allMail);
    try {
      for (const id of ids) {
        const row = byId.get(String(id));
        if (!row) { skipped.push({ id, reason: "no-row" }); continue; }
        if (row.channel === "sms") { skipped.push({ id, reason: "sms" }); continue; }
        let uid = null, reason = "";
        // 1) Exact match by unique Message-ID (imported mail, and forwarded mail where Gmail kept it).
        const key = norm(row.original_message_id || row.message_id);
        if (key) {
          try {
            const u = await client.search({ gmailRaw: `rfc822msgid:${key}` }, { uid: true });
            if (u && u.length === 1) uid = u[0];
            else if (u && u.length > 1) reason = "ambiguous-id";
          } catch (_) { reason = "search-error"; }
        }
        // 2) Fallback ONLY for TRASH (the user-confirmed, recoverable action) on FORWARDED mail whose
        //    forwarded copy carries a different Message-ID: locate by sender + exact subject in a recent
        //    window, requiring BOTH constraints and acting on a SINGLE hit only. Both are sanitized so a
        //    quote/space can't inject Gmail search operators. Read-state sync stays exact-Message-ID only,
        //    so a fuzzy match can never silently flag the wrong message.
        if (uid == null && action === "trash") {
          const clean = (s) => String(s || "").replace(/["\\\r\n]+/g, " ").trim();
          const from = clean(row.from_email), subj = clean(row.subject);
          if (from && subj) {
            try {
              const u = await client.search({ gmailRaw: `from:${from} subject:"${subj}" newer_than:2y` }, { uid: true });
              if (u && u.length === 1) uid = u[0];
              else reason = (u && u.length > 1) ? "ambiguous-match" : (reason || "not-found");
            } catch (_) { reason = reason || "search-error"; }
          } else if (!reason) reason = "not-found";
        }
        if (uid == null) { skipped.push({ id, reason: reason || "not-found" }); continue; }
        try {
          if (action === "markRead")        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          else if (action === "markUnread") await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
          else if (action === "trash")      await client.messageMove(uid, trash, { uid: true });
          updated.push(id);
        } catch (_) { skipped.push({ id, reason: "op-error" }); }
      }
    } finally { try { lock.release(); } catch (_) {} }
    try { await client.logout(); } catch (_) {}
    return res.status(200).json({ ok: true, action, updated, skipped });
  } catch (e) {
    try { if (client) await client.logout(); } catch (_) {}
    const msg = String((e && e.message) || e);
    const hint = /auth|login|credentials|invalid/i.test(msg) ? " — check the Gmail app password (and that IMAP is enabled)." : "";
    return res.status(502).json({ ok: false, error: `Gmail action failed: ${msg}${hint}`, updated, skipped });
  }
}
