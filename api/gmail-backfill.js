// api/gmail-backfill.js — one-time (re-runnable) import of the owner's EXISTING Gmail into
// the work-email funnel (sps_inbox), so history is AI-sorted alongside new forwarded mail.
//
// Uses IMAP with a Google APP PASSWORD (not OAuth — OAuth for Gmail needs restricted-scope
// verification, weeks of Google review; an app password is a 2-minute owner setup and read-only
// enough for this). Env: GMAIL_IMAP_USER (the address) + GMAIL_IMAP_PASSWORD (the 16-char app
// password from myaccount.google.com/apppasswords, 2-Step Verification required). Ships dark
// until both are set.
//
// OWNER-ONLY (requireOwner). Paged: the app calls repeatedly with a growing offset (newest
// first) so no single request risks Vercel's timeout. Imported rows are read=true (history must
// not flood the unread badge) and carry the ORIGINAL received date, and NO pushes fire. AI
// triage is client-match-first (free/instant), then Claude for the rest under a per-run cap so a
// big inbox can't run up a bill in one call. Dedupe is by a deterministic id from the RFC
// Message-ID, and the upsert is ignore-duplicates, so re-running is safe and cheap.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { callClaude, extractJson, aiConfigured } from "./_ai.js";
import { requireOwner } from "./plaid/_plaid.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IMAP_USER    = process.env.GMAIL_IMAP_USER;
const IMAP_PASS    = process.env.GMAIL_IMAP_PASSWORD;

export const config = { maxDuration: 300 }; // IMAP fetch + per-page AI triage; well under the cap

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
async function inboxHas(id) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(id)}&select=id`, { headers: sbHeaders() });
    if (!r.ok) return false;
    return ((await r.json().catch(() => [])) || []).length > 0;
  } catch { return false; }
}

const htmlToText = (h) => String(h || "")
  .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

// KEEP IN SYNC with api/inbound-email.js TRIAGE_SYSTEM (deliberately duplicated to avoid touching
// the live funnel; if you change one, change the other).
const TRIAGE_SYSTEM = `You triage the work-email inbox for a pond/pool service business owner. Classify ONE email and reply with STRICT JSON only, no prose:
{"kind":"lead"|"bill"|"client"|"other","confidence":0..1,"summary":"one plain sentence",
 "lead":{"name":"","phone":"","email":"","service":"","message":""},
 "bill":{"vendor":"","amount":"","dueDate":""}}
Rules: "lead" = a person asking about getting service, a quote, an estimate, availability. "bill" = money the business owes (invoices TO the business, statements, utilities, suppliers, subscriptions). "client" = an existing customer writing about their own service (the caller tells you if the sender matched the client list). Marketing blasts, newsletters, receipts for tiny purchases, spam, notifications = "other". Never invent contact details.`;

const idFor = (messageId, uid, dateIso) =>
  "im_" + Buffer.from(String(messageId || `${uid}|${dateIso}`)).toString("base64url").slice(0, 48);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, configured: { imap: !!(IMAP_USER && IMAP_PASS), ai: aiConfigured() } });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!SERVICE_KEY) return res.status(501).json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });

  const u = await requireOwner(req, res, "the Gmail import");
  if (!u) return;
  if (!IMAP_USER || !IMAP_PASS) return res.status(501).json({ error: "Gmail import isn't set up yet — add GMAIL_IMAP_USER and GMAIL_IMAP_PASSWORD (a Google app password) in Vercel.", missingEnv: true });

  const b = req.body || {};
  const sinceDays = Math.min(3650, Math.max(1, parseInt(b.sinceDays, 10) || 90));
  const offset = Math.max(0, parseInt(b.offset, 10) || 0);
  const pageSize = Math.min(25, Math.max(1, parseInt(b.pageSize, 10) || 12));
  const aiCap = Math.min(60, Math.max(0, parseInt(b.aiCap, 10) || 40));

  const selfAddrs = new Set([IMAP_USER].map(e => String(e || "").trim().toLowerCase()));
  let client;
  try {
    const clients = await sbGet("sps_clients", []);
    const clientByEmail = new Map();
    (Array.isArray(clients) ? clients : []).forEach(c => { const e = String(c.email || "").trim().toLowerCase(); if (e) clientByEmail.set(e, c); });

    client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
    await client.connect();
    let imported = 0, skipped = 0, aiUsed = 0, total = 0;
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - sinceDays * 86400000);
      const uids = await client.search({ since }, { uid: true }); // ascending UIDs
      const ordered = (uids || []).slice().reverse();             // newest first
      total = ordered.length;
      const page = ordered.slice(offset, offset + pageSize);
      for (const uid of page) {
        let parsed;
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) { skipped++; continue; }
          parsed = await simpleParser(msg.source);
        } catch (_) { skipped++; continue; }

        const fromObj = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
        const fromEmail = String(fromObj.address || "").trim().toLowerCase();
        const fromName = String(fromObj.name || "").trim();
        if (fromEmail && selfAddrs.has(fromEmail)) { skipped++; continue; } // our own sent mail
        const subject = String(parsed.subject || "").slice(0, 300);
        const dateIso = (parsed.date instanceof Date && !isNaN(parsed.date)) ? parsed.date.toISOString() : new Date().toISOString();
        const messageId = String(parsed.messageId || "").slice(0, 300);
        const id = idFor(messageId, uid, dateIso);
        if (await inboxHas(id)) { skipped++; continue; } // already imported — no re-AI, no re-write

        const text = (String(parsed.text || "").trim() || htmlToText(parsed.html)).slice(0, 20000);
        const html = String(parsed.html || "").replace(/<script[\s\S]*?<\/script>/gi, "").slice(0, 300000);
        const matched = clientByEmail.get(fromEmail);

        let kind = matched ? "client" : "other", ai = matched ? { summary: `From client ${matched.name}`, clientId: String(matched.id) } : null;
        if (!matched && aiConfigured() && aiUsed < aiCap) {
          aiUsed++;
          try {
            const reply = await callClaude({
              system: TRIAGE_SYSTEM,
              content: `From: ${fromName} <${fromEmail}>\nSubject: ${subject}\nSender matched client list: no\n\n${text.slice(0, 4000)}`,
              maxTokens: 500, temperature: 0,
            });
            const j = extractJson(reply);
            if (j && ["lead", "bill", "client", "other"].includes(j.kind)) { ai = j; kind = j.kind === "client" ? "other" : j.kind; }
          } catch (_) { /* leave as "other" */ }
        }

        const row = { id, from_name: fromName.slice(0, 120), from_email: fromEmail.slice(0, 200), subject, body_text: text, body_html: html, message_id: messageId, kind, ai, lead_id: "", read: true, replied: false, created_at: dateIso };
        try {
          const ir = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?on_conflict=id`, {
            method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=ignore-duplicates" },
            body: JSON.stringify([row]),
          });
          if (ir.ok) imported++; else skipped++;
        } catch (_) { skipped++; }
      }
    } finally { try { lock.release(); } catch (_) {} }
    try { await client.logout(); } catch (_) {}

    const nextOffset = Math.min(offset + pageSize, total);
    return res.status(200).json({ ok: true, total, imported, skipped, aiUsed, offset, nextOffset, done: nextOffset >= total });
  } catch (e) {
    try { if (client) await client.logout(); } catch (_) {}
    const msg = String((e && e.message) || e);
    const hint = /auth|login|credentials|invalid/i.test(msg) ? " — check the Gmail app password (and that IMAP is enabled in Gmail settings)." : "";
    return res.status(502).json({ error: `Gmail import failed: ${msg}${hint}` });
  }
}
