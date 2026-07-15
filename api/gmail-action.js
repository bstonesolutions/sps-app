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
//     unique, so a wrong-message hit is effectively impossible. Forwarded wrappers may use a
//     different id; those use an exact sender + subject + close-arrival fallback that fails closed
//     when read-state matching is ambiguous. The app only saves email state Gmail confirms.
//   • DELETE is a MOVE TO TRASH (recoverable ~30 days), never an expunge/permanent delete.
//   • SMS rows (channel='sms') have no IMAP counterpart → always skipped.
// Ships dark until GMAIL_IMAP_USER + GMAIL_IMAP_PASSWORD are set.

import { ImapFlow } from "imapflow";
import { requireOwner } from "./plaid/_plaid.js";
import { chooseGmailFallbackCandidate, newestGmailCandidateUids, safeGmailMessageId } from "../gmailActionSafety.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IMAP_USER    = process.env.GMAIL_IMAP_USER;
const IMAP_PASS    = process.env.GMAIL_IMAP_PASSWORD;

export const config = { maxDuration: 60 };

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });

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

const cleanSearchText = (value) => String(value || "")
  .replace(/["\\\r\n(){}\[\]]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 220);

// Search the mailbox that is currently locked/open. Exact Message-ID is preferred. Forwarded
// mail can carry a wrapper id, so a strict sender + subject + arrival-time fallback is available;
// read state only accepts one candidate, while recoverable Trash may choose the unique nearest.
async function findMessageInOpenMailbox(client, row, { allowNearest = false } = {}) {
  const rawMessageId = row.original_message_id || row.message_id;
  const messageId = safeGmailMessageId(rawMessageId);
  let reason = rawMessageId && !messageId ? "unsafe-id" : "not-found";
  if (messageId) {
    try {
      const hits = await client.search({ gmailRaw: `rfc822msgid:${messageId}` }, { uid: true });
      if (hits && hits.length === 1) return { uid: hits[0], reason: "message-id" };
      if (hits && hits.length > 1) return { uid: null, reason: "ambiguous-id" };
    } catch (_) { return { uid: null, reason: "search-error" }; }
  }

  const from = cleanSearchText(row.from_email).toLowerCase();
  const subject = cleanSearchText(row.subject);
  if (!/^[A-Za-z0-9._%+\-/=]+@[A-Za-z0-9.-]+$/.test(from) || !subject) return { uid: null, reason };
  try {
    const hits = await client.search({ gmailRaw: `from:${from} subject:"${subject}"` }, { uid: true });
    const candidateUids = newestGmailCandidateUids(hits, 60);
    if (!candidateUids.length) return { uid: null, reason };
    const candidates = [];
    for await (const message of client.fetch(candidateUids, { uid: true, internalDate: true, envelope: true }, { uid: true })) {
      candidates.push(message);
    }
    return chooseGmailFallbackCandidate(row, candidates, { allowNearest });
  } catch (_) { return { uid: null, reason: "search-error" }; }
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

  // Load every match key before opening IMAP. A failed lookup is a server error, not a benign
  // "not found" result; otherwise the client could believe Gmail was checked when it was not.
  let rows;
  try {
    const lookup = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=in.(${ids.map(encodeURIComponent).join(",")})&select=id,message_id,original_message_id,channel,source_type,from_email,subject,created_at`, { headers: sbHeaders() });
    if (!lookup.ok) return res.status(502).json({ ok: false, error: "Inbox could not be checked before the Gmail action.", updated: [], skipped: ids.map(id => ({ id, reason: "lookup-error" })) });
    rows = await lookup.json().catch(() => null);
    if (!Array.isArray(rows)) return res.status(502).json({ ok: false, error: "Inbox returned an invalid Gmail lookup response.", updated: [], skipped: ids.map(id => ({ id, reason: "lookup-error" })) });
  } catch (_) {
    return res.status(502).json({ ok: false, error: "Inbox could not be reached before the Gmail action.", updated: [], skipped: ids.map(id => ({ id, reason: "lookup-error" })) });
  }

  const byId = new Map(rows.map(row => [String(row.id), row]));
  const updated = [], skipped = [], changes = [], emailIds = [];
  for (const id of ids) {
    const row = byId.get(String(id));
    if (!row) skipped.push({ id, reason: "no-row" });
    else if (row.channel === "sms") skipped.push({ id, reason: "sms" });
    else emailIds.push(id);
  }
  // Mixed selections should not pay the cost of an IMAP connection when every row is a text.
  if (!emailIds.length) return res.status(200).json({ ok: true, action, updated, skipped, changes });

  let client;
  try {
    client = new ImapFlow({
      host: "imap.gmail.com", port: 993, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS },
      logger: false, connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 12000,
    });
    await client.connect();
    const allMail = await findBox(client, "\\All", "[Gmail]/All Mail");
    const trash = action === "trash" ? await findBox(client, "\\Trash", "[Gmail]/Trash") : null;
    const unresolvedTrash = [];
    const lock = await client.getMailboxLock(allMail);
    try {
      for (const id of emailIds) {
        const row = byId.get(String(id));
        const match = await findMessageInOpenMailbox(client, row, { allowNearest: action === "trash" });
        if (match.uid == null) {
          if (action === "trash") unresolvedTrash.push({ id, row, reason: match.reason || "not-found" });
          else skipped.push({ id, reason: match.reason || "not-found" });
          continue;
        }
        try {
          if (action === "markRead" || action === "markUnread") {
            const before = await client.fetchOne(match.uid, { flags: true }, { uid: true });
            if (!before || !(before.flags instanceof Set)) { skipped.push({ id, reason: "state-error" }); continue; }
            const previousRead = before.flags.has("\\Seen");
            const desiredRead = action === "markRead";
            if (previousRead !== desiredRead) {
              const applied = desiredRead
                ? await client.messageFlagsAdd(match.uid, ["\\Seen"], { uid: true })
                : await client.messageFlagsRemove(match.uid, ["\\Seen"], { uid: true });
              if (!applied) { skipped.push({ id, reason: "op-error" }); continue; }
              changes.push({ id, changed: true, previousRead });
            } else {
              changes.push({ id, changed: false, previousRead });
            }
          } else {
            const applied = await client.messageMove(match.uid, trash, { uid: true });
            if (!applied) { skipped.push({ id, reason: "op-error" }); continue; }
          }
          updated.push(id);
        } catch (_) { skipped.push({ id, reason: "op-error" }); }
      }
    } finally { try { lock.release(); } catch (_) {} }

    // Idempotent delete retry: if Gmail already accepted the move but SPS failed to delete its row,
    // the next attempt must treat the matching message in Trash as confirmed instead of getting
    // permanently stuck because All Mail no longer contains it.
    if (action === "trash" && unresolvedTrash.length) {
      const trashLock = await client.getMailboxLock(trash);
      try {
        for (const pending of unresolvedTrash) {
          const match = await findMessageInOpenMailbox(client, pending.row, { allowNearest: true });
          if (match.uid != null) {
            updated.push(pending.id);
            changes.push({ id: pending.id, changed: false, alreadyApplied: true });
          }
          else skipped.push({ id: pending.id, reason: match.reason || pending.reason || "not-found" });
        }
      } finally { try { trashLock.release(); } catch (_) {} }
    }

    try { await client.logout(); } catch (_) {}
    return res.status(200).json({ ok: true, action, updated, skipped, changes });
  } catch (e) {
    try { if (client) client.close(); } catch (_) {}
    const msg = String((e && e.message) || e);
    const timedOut = /timeout|timed out|socket/i.test(msg);
    const hint = /auth|login|credentials|invalid/i.test(msg) ? " — check the Gmail app password (and that IMAP is enabled)." : "";
    const remaining = emailIds.filter(id => !updated.map(String).includes(String(id)) && !skipped.some(item => String(item.id) === String(id)));
    remaining.forEach(id => skipped.push({ id, reason: timedOut ? "imap-timeout" : "imap-error" }));
    return res.status(502).json({ ok: false, error: `Gmail action failed: ${msg}${hint}`, updated, skipped, changes });
  }
}
