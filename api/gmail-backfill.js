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

import crypto from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { callClaude, extractJson, aiConfigured } from "./_ai.js";
import { requireOwner } from "./plaid/_plaid.js";
import { assessInboundLead } from "../leadQualification.js";
import { shouldDeferToLiveForward } from "../emailIntakeSafety.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IMAP_USER    = process.env.GMAIL_IMAP_USER;
const IMAP_PASS    = process.env.GMAIL_IMAP_PASSWORD;

export const config = { maxDuration: 300 }; // IMAP fetch + per-page AI triage; well under the cap

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const parseVal = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
async function sbGetResult(key, fallback) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
    if (!r.ok) return { ok: false, exists: false, value: fallback };
    const rows = await r.json().catch(() => []);
    const v = rows && rows[0] ? parseVal(rows[0].value) : null;
    return { ok: true, exists: !!(rows && rows[0]), value: v == null ? fallback : v };
  } catch { return { ok: false, exists: false, value: fallback }; }
}
async function inboxHas(id) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(id)}&select=id`, { headers: sbHeaders() });
    if (!r.ok) return false;
    return ((await r.json().catch(() => [])) || []).length > 0;
  } catch { return false; }
}
async function inboxHasMessageId(messageId) {
  if (!messageId) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?message_id=eq.${encodeURIComponent(messageId)}&select=id&limit=1`, { headers: sbHeaders() });
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
{"kind":"lead"|"bill"|"client"|"other","confidence":0..1,"intent":"new_business"|"existing_service"|"billing"|"other","automated":true|false,"evidence":"exact short excerpt from the email","summary":"one plain sentence",
 "lead":{"name":"","phone":"","email":"","service":"","message":""},
 "bill":{"vendor":"","amount":"","dueDate":""}}
Rules: "lead" = a real person explicitly asking about NEW service, a quote, an estimate, pricing, or availability. Service reports, repair/work-order notices, visit updates, software notifications, and messages about existing service are NEVER leads. "bill" = money the business owes (invoices TO the business, statements, utilities, suppliers, subscriptions). "client" = an existing customer writing about their own service (the caller tells you if the sender matched the client list). Marketing blasts, newsletters, receipts for tiny purchases, spam, notifications = "other". Set automated=true for no-reply/software/platform mail. Evidence must quote the exact request/quote/new-service wording that proves the classification. Never invent contact details.`;

// Deterministic id from the FULL Message-ID (SHA-256 → no prefix-collision risk that a 48-char
// base64url slice would have for Message-IDs sharing a long prefix). No Message-ID → uid+date.
const normalizedMessageId = (value) => String(value || "").trim().replace(/^<|>$/g, "").toLowerCase();
const idFor = (messageId, uid, dateIso) => {
  const normalized = normalizedMessageId(messageId);
  return normalized
    ? "mail_" + crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32)
    : "im_" + crypto.createHash("sha1").update(`${uid}|${dateIso}`).digest("hex").slice(0, 32);
};

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
  const requestedAiCap = parseInt(b.aiCap, 10);
  const aiCap = Number.isFinite(requestedAiCap) ? Math.min(60, Math.max(0, requestedAiCap)) : 40;

  let client;
  try {
    const [clientRead, emailRead] = await Promise.all([sbGetResult("sps_clients", []), sbGetResult("sps_email", {})]);
    const clientLookupOk = clientRead.ok && clientRead.exists && Array.isArray(clientRead.value);
    const clients = clientLookupOk ? clientRead.value : [];
    const emailCfg = emailRead.value && typeof emailRead.value === "object" ? emailRead.value : {};
    const resendFromAddr = ((process.env.RESEND_FROM || "noreply@stonepropertysolutions.com").match(/[^<\s]+@[^>\s]+/) || [])[0];
    const selfAddrs = new Set([
      IMAP_USER,
      emailCfg.fromAddress,
      emailCfg.ownerEmail,
      emailCfg.notify && emailCfg.notify.ownerEmail,
      resendFromAddr,
      "noreply@stonepropertysolutions.com",
    ].filter(Boolean).map(e => String(e).trim().toLowerCase()));
    const clientsByEmail = new Map();
    clients.forEach(c => {
      const e = String(c.email || "").trim().toLowerCase();
      if (!e) return;
      clientsByEmail.set(e, [...(clientsByEmail.get(e) || []), c]);
    });

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
        // New mail belongs to the live forwarding webhook, which marks it unread and can notify.
        // Holding a short grace window prevents a manual history import from claiming that same
        // canonical row first and silently turning a brand-new lead into read history.
        if (shouldDeferToLiveForward(parsed.date)) { skipped++; continue; }
        const dateIso = (parsed.date instanceof Date && !isNaN(parsed.date)) ? parsed.date.toISOString() : new Date().toISOString();
        const messageId = String(parsed.messageId || "").slice(0, 300);
        const id = idFor(messageId, uid, dateIso);
        if (await inboxHas(id) || await inboxHasMessageId(messageId)) { skipped++; continue; } // live-forward/history duplicate — no re-AI

        const text = (String(parsed.text || "").trim() || htmlToText(parsed.html)).slice(0, 20000);
        const html = String(parsed.html || "").replace(/<script[\s\S]*?<\/script>/gi, "").slice(0, 300000);
        const emailMatches = clientsByEmail.get(fromEmail) || [];
        const matched = emailMatches.length === 1 ? emailMatches[0] : null;
        const ambiguousClient = emailMatches.length > 1;

        let kind = matched ? "client" : "other", ai = matched
          ? { summary: `From client ${matched.name}`, clientId: String(matched.id) }
          : ambiguousClient ? { summary: "This email address matches more than one client. Review it before replying." } : null;
        const row = { id, from_name: fromName.slice(0, 120), from_email: fromEmail.slice(0, 200), subject, body_text: text, body_html: html, message_id: messageId, kind, ai, lead_id: "", read: true, replied: false, created_at: dateIso, source_type: "email_imported", gmail_uid: Number(uid) || 0 };
        try {
          // Claim the same canonical row used by live forwarding before running Claude. If the live
          // webhook or another backfill invocation already won, this request is a true no-op.
          const ir = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?on_conflict=id`, {
            method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=ignore-duplicates,return=representation" },
            body: JSON.stringify([row]),
          });
          const inserted = ir.ok ? await ir.json().catch(() => []) : [];
          if (!Array.isArray(inserted) || !inserted.length) { skipped++; continue; }
          imported++;
        } catch (_) { skipped++; continue; }

        if (!matched && !ambiguousClient && clientLookupOk && aiConfigured() && aiUsed < aiCap) {
          aiUsed++;
          try {
            const reply = await callClaude({
              system: TRIAGE_SYSTEM,
              content: `From: ${fromName} <${fromEmail}>\nSubject: ${subject}\nSender matched client list: no\n\n${text.slice(0, 4000)}`,
              maxTokens: 500, temperature: 0,
            });
            const j = extractJson(reply);
            if (j && ["lead", "bill", "client", "other"].includes(j.kind)) {
              ai = j;
              if (j.kind === "lead") {
                const verdict = assessInboundLead({ from_email: fromEmail, from_name: fromName, subject, body_text: text, ai: j }, clients);
                kind = verdict.eligible ? "lead" : verdict.kind;
                if (!verdict.eligible) ai = { ...j, autoLead: false, leadRejectedReason: verdict.reason, ...(verdict.client ? { clientId: String(verdict.client.id) } : {}) };
              } else {
                kind = j.kind === "client" ? "other" : j.kind;
              }
              // Classification is optional; if this PATCH fails the already-durable row remains
              // safely in Other instead of becoming an unconfirmed lead or bill.
              const pr = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(id)}&kind=eq.other&lead_id=eq.`, {
                method: "PATCH",
                headers: { ...sbHeaders(), Prefer: "return=representation" },
                body: JSON.stringify({ kind, ai }),
              });
              const patched = pr.ok ? await pr.json().catch(() => []) : [];
              if (!Array.isArray(patched) || !patched.some((saved) => String(saved && saved.id) === String(id))) {
                kind = "other";
                ai = null;
              }
            }
          } catch (_) { /* leave as "other" */ }
        }
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
