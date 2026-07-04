// api/inbound-email.js — the work-email funnel (Resend Inbound webhook).
//
// Flow: brandon@stonepropertysolutions.com (Google Workspace — UNTOUCHED) auto-forwards a copy
// to <anything>@in.spsway.app → Resend receives it (MX on the subdomain) → fires email.received
// here. The webhook payload is METADATA ONLY (Resend never posts bodies to webhooks), so we
// fetch the full content server-to-server with the API key — which also means a forged webhook
// can at worst make us re-fetch a real email we already have; content always comes from Resend.
//
// Then Claude triages it — lead / bill / client / other — and routes:
//   lead   → stored + owner push ("new_lead" toggle); the APP imports it into sps_leads on next
//            open (two-phase like website leads — the server NEVER writes sps_leads directly,
//            same single-writer rule that keeps the array race-free)
//   bill   → stored + owner push ("bill_received" toggle)
//   client → stored, tagged with the matched client (from_email ∈ sps_clients)
//   other  → stored, waiting quietly in Comms → Email
// Everything lands in sps_inbox (service-role only — the owner's PRIVATE mail; read through
// the owner-gated api/inbox.js, never the shared supabase client).
//
// Auth: ?key=<INBOUND_WEBHOOK_SECRET> in the webhook URL (set when adding the endpoint in the
// Resend dashboard). RETRY CONTRACT: genuine skips + success → 200; TRANSIENT failures
// (Resend fetch error, store failure) → 5xx ON PURPOSE so Resend's ~28h retry schedule
// redelivers — the dup pre-check + ignore-duplicates upsert make retries fully idempotent
// (no double-push, no double-AI), so a 200 would just silently LOSE the email (Resend never
// retries a 2xx, and it deletes content after ~30 days). AI down/unset → kind falls back
// conservatively and nothing breaks. sps_inbox is the system of record.
//
// SPAM GUARDS: the subdomain is a catch-all, so (1) only mail addressed to the expected
// forward target (INBOUND_ALLOWED_TO, default local-part "inbox") is ingested — dictionary
// spam to random@in.spsway.app is skipped outright; (2) AI triage is capped per hour
// (over budget → stored as "other", no push — the owner can reclassify in Comms → Email).

import { callClaude, extractJson, aiConfigured } from "./_ai.js";
import { pushOwner } from "./_push.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const SECRET       = process.env.INBOUND_WEBHOOK_SECRET;

const ALLOWED_TO = String(process.env.INBOUND_ALLOWED_TO || "inbox").toLowerCase();
const AI_HOURLY_CAP = 30;

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const parseVal = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
async function sbSet(key, obj) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=key`, {
      method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ key, value: JSON.stringify(obj) }]),
    });
  } catch { /* best-effort */ }
}
async function sbGet(key, fallback) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
    if (!r.ok) return fallback;
    const rows = await r.json().catch(() => []);
    const v = rows && rows[0] ? parseVal(rows[0].value) : null;
    return v == null ? fallback : v;
  } catch { return fallback; }
}

// "Name <addr@x.com>" → { name, email }
function parseAddr(s) {
  const str = String(s || "");
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(str);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: str.trim().toLowerCase() };
}
// Crude but safe HTML → text for triage/preview when no text part exists. Anchor hrefs are
// PRESERVED — "Confirm here" becomes "Confirm here ( https://… )" — so verification links and
// pay links survive into the reader instead of being silently stripped.
const htmlToText = (h) => String(h || "")
  .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const t = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!/^https?:/i.test(href)) return t;                 // mailto/tel/anchors → keep text only
    // Only inline SHORT urls (verification links etc.) — marketing emails carry giant encoded
    // tracking links that turn the text body into garbage soup. Long links live in body_html.
    if (href.length > 90) return t;
    return !t || t === href ? ` ${href} ` : `${t} ( ${href} )`;
  })
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

const TRIAGE_SYSTEM = `You triage the work-email inbox for a pond/pool service business owner. Classify ONE email and reply with STRICT JSON only, no prose:
{"kind":"lead"|"bill"|"client"|"other","confidence":0..1,"summary":"one plain sentence",
 "lead":{"name":"","phone":"","email":"","service":"","message":""},   // only when kind=lead: extract what the person wants, service guess (Pond/Pool/Seasonal), contact details found in the email
 "bill":{"vendor":"","amount":"","dueDate":""}}                        // only when kind=bill: invoice/statement/utility/supplier charge aimed at the BUSINESS
Rules: "lead" = a person asking about getting service, a quote, an estimate, availability. "bill" = money the business owes (invoices TO the business, statements, utilities, suppliers, subscriptions). "client" = an existing customer writing about their own service (the caller tells you if the sender matched the client list). Marketing blasts, newsletters, receipts for tiny purchases, spam, notifications = "other". Never invent contact details.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, configured: { resend: !!RESEND_KEY, secret: !!SECRET, ai: aiConfigured() } });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!SECRET) return res.status(501).json({ error: "Server missing INBOUND_WEBHOOK_SECRET", missingEnv: true });
  const q = req.query || {};
  if (String(q.key || "") !== SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (!SERVICE_KEY || !RESEND_KEY) return res.status(501).json({ error: "Server missing SERVICE/RESEND key", missingEnv: true });

  const out = { ok: true };
  try {
    const body = req.body || {};
    if (body.type && body.type !== "email.received") return res.status(200).json({ ok: true, skipped: body.type });
    const emailId = body.data && body.data.email_id;
    if (!emailId) return res.status(200).json({ ok: true, skipped: "no email_id" });

    // Webhook retries/replays must be TRUE no-ops: if we already stored this email, stop before
    // re-triaging (an extra Claude call) or re-pushing the owner's phone.
    try {
      const dup = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(String(emailId))}&select=id`, { headers: sbHeaders() });
      if (dup.ok && ((await dup.json().catch(() => [])) || []).length) return res.status(200).json({ ok: true, duplicate: true });
    } catch (_) { /* dup check is best-effort; the insert below still won't clobber */ }

    // Fetch the real content from Resend (the webhook is metadata-only — and untrusted).
    const er = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${RESEND_KEY}` },
    });
    if (er.status === 404) return res.status(200).json({ ok: true, skipped: "email no longer at Resend" });
    if (!er.ok) return res.status(502).json({ ok: false, error: `Resend fetch ${er.status} — please retry` });
    const em = await er.json().catch(() => ({}));

    // Recipient allowlist — the Gmail forward targets ONE known address; anything else hitting
    // the catch-all subdomain is dictionary spam and never enters the funnel.
    const rcpts = [].concat(em.to || [], em.received_for || []).map(a => parseAddr(a).email).filter(Boolean);
    const allowed = rcpts.some(a => a === ALLOWED_TO || a.split("@")[0] === ALLOWED_TO);
    if (rcpts.length && !allowed) return res.status(200).json({ ok: true, skipped: `unexpected recipient (allowed: ${ALLOWED_TO})` });
    const { name: fromName, email: fromEmail } = parseAddr(em.from);
    const subject = String(em.subject || "").slice(0, 300);
    const text = (String(em.text || "").trim() || htmlToText(em.html)).slice(0, 20000);
    // The real HTML rides along (scripts stripped; the app renders it in a sandboxed frame) so
    // emails look like they do in Gmail — text stays the AI/preview/search form.
    const html = String(em.html || "").replace(/<script[\s\S]*?<\/script>/gi, "").slice(0, 300000);
    const messageId = String(em.message_id || (body.data && body.data.message_id) || "").slice(0, 300);

    const [clients, emailCfg] = await Promise.all([sbGet("sps_clients", []), sbGet("sps_email", {})]);

    // LOOP GUARD: replies the app itself sends are BCC'd back to the owner for record-keeping,
    // and Gmail's forward rule dutifully bounces that copy here. Never re-ingest our own sends.
    const selfAddrs = [emailCfg.fromAddress, emailCfg.ownerEmail, emailCfg.notify && emailCfg.notify.ownerEmail]
      .filter(Boolean).map(e => String(e).trim().toLowerCase());
    if (fromEmail && selfAddrs.includes(fromEmail)) return res.status(200).json({ ok: true, skipped: "own send — loop guard" });

    // Existing client? (from_email against the client list — decided BEFORE the AI call.)
    const client = (Array.isArray(clients) ? clients : []).find(c => String(c.email || "").trim().toLowerCase() === fromEmail && fromEmail);

    // Triage. Client mail skips the AI (we already know what it is); AI failure degrades to
    // "other". Hourly budget caps spam-driven spend — over budget, mail still stores as
    // "other" (reclassify in Comms → Email), it just doesn't bill or buzz.
    let kind = client ? "client" : "other", ai = null;
    let underBudget = true;
    if (!client && aiConfigured()) {
      const hourKey = new Date().toISOString().slice(0, 13);
      const budget = (await sbGet("sps_inbound_ai_budget", {})) || {};
      const used = budget.h === hourKey ? (Number(budget.n) || 0) : 0;
      underBudget = used < AI_HOURLY_CAP;
      if (underBudget) await sbSet("sps_inbound_ai_budget", { h: hourKey, n: used + 1 });
    }
    if (!client && aiConfigured() && underBudget) {
      try {
        const reply = await callClaude({
          system: TRIAGE_SYSTEM,
          content: `From: ${fromName} <${fromEmail}>\nSubject: ${subject}\nSender matched client list: no\n\n${text.slice(0, 4000)}`,
          maxTokens: 500, temperature: 0,
        });
        const j = extractJson(reply);
        if (j && ["lead", "bill", "client", "other"].includes(j.kind)) {
          ai = j;
          kind = j.kind === "client" ? "other" : j.kind; // AI can't declare "client" — only the list match can
        }
      } catch (_) { /* AI down → "other"; the owner can reclassify in the Email tab */ }
    }

    // Store (upsert on the Resend id — retries and replays collapse into one row).
    const row = {
      id: String(emailId),
      from_name: fromName.slice(0, 120), from_email: fromEmail.slice(0, 200),
      subject, body_text: text, body_html: html, message_id: messageId,
      kind, ai: ai || (client ? { summary: `From client ${client.name}`, clientId: String(client.id) } : null),
      lead_id: "", read: false,
    };
    // ignore-duplicates (ON CONFLICT DO NOTHING): a concurrent retry can never reset the
    // owner's read/lead_id flags back to fresh — first write wins, forever.
    const ir = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?on_conflict=id`, {
      method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify([row]),
    });
    if (!ir.ok) {
      const t = await ir.text().catch(() => "");
      out.stored = false;
      out.error = /relation .*sps_inbox|42P01/i.test(t) ? "sps_inbox table missing — run the SQL in CLAUDE.md" : t.slice(0, 200);
      // 5xx ON PURPOSE: Resend retries for ~28h, so mail arriving before the table exists (or
      // during a Supabase blip) is delivered later instead of silently lost.
      return res.status(502).json(out);
    }
    out.stored = true;
    out.kind = kind;

    // Alerts — best-effort pushes through the same toggles as everything else.
    if (kind === "lead") {
      const who = (ai && ai.lead && ai.lead.name) || fromName || fromEmail;
      out.push = await pushOwner("new_lead", `Email lead: ${who}`, (ai && ai.summary) || subject || "Open Comms → Email", "comms", { collapseId: `em-${emailId}` });
    } else if (kind === "bill") {
      const b = (ai && ai.bill) || {};
      out.push = await pushOwner("bill_received", "Bill received", [b.vendor, b.amount, b.dueDate ? `due ${b.dueDate}` : ""].filter(Boolean).join(" — ") || subject, "comms", { collapseId: `em-${emailId}` });
    }
  } catch (e) {
    // Unknown failure before/around the store → let Resend retry (idempotent by design).
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
  return res.status(200).json(out);
}
