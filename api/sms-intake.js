// api/sms-intake.js — inbound SMS funnel (Quo/OpenPhone `message.received` webhook).
//
// Someone texts the business number → this fires → the text flows into the SAME AI-sorted
// inbox as work email (sps_inbox, channel 'sms'): an existing client's text is tagged "Client";
// an unknown number is AI-triaged (lead/bill/other) and, when it's a lead, auto-imports into
// Comms → Leads with a push — exactly like an email lead. Outbound texts WE send ride the same
// Quo message stream with direction "outgoing"; we drop those so we never ingest our own sends.
//
// Auth: ?key=<QUO_WEBHOOK_KEY> in the webhook URL (Quo POSTs the URL verbatim). Optional HMAC
// verification of the openphone-signature header when QUO_WEBHOOK_SECRET is set (defense in
// depth). Always 200 once authorized — Quo retries non-2xx for up to 3 days, and the upsert on
// the envelope id makes retries harmless. Ships dark until QUO_WEBHOOK_KEY is set.
//
// One-time SQL (CLAUDE.md): ALTER TABLE sps_inbox ADD COLUMN channel + from_phone.

import crypto from "node:crypto";
import { callClaude, extractJson, aiConfigured } from "./_ai.js";
import { mutateAppState, NO_APP_STATE_CHANGE, readAppStateVersioned } from "./_app-state.js";
import { pushOwner } from "./_push.js";

export const config = { api: { bodyParser: false } }; // need the RAW body for HMAC verification

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KEY          = process.env.QUO_WEBHOOK_KEY;
const SIGN_SECRET  = process.env.QUO_WEBHOOK_SECRET; // optional openphone signing secret (base64)

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
async function sbGet(key, fallback) {
  try {
    const row = await readAppStateVersioned(key);
    return row.exists && row.value != null ? row.value : fallback;
  } catch { return fallback; }
}
async function inboxHas(id) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(id)}&select=id`, { headers: sbHeaders() });
    return r.ok && ((await r.json().catch(() => [])) || []).length > 0;
  } catch { return false; }
}
const SMS_AI_HOURLY_CAP = 30;
const digits = (s) => String(s || "").replace(/\D/g, "");
const last10 = (s) => digits(s).slice(-10);
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").slice(0, n).trim();
const fmtPhone = (p) => { const d = last10(p); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || ""); };

// Read the raw request body (bodyParser is off). Collect BUFFERS and concat once — string
// concatenation would corrupt a multi-byte char (emoji, accents — routine in SMS) split across
// stream chunks, which breaks both body_text and the HMAC digest.
function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}
// openphone-signature: "hmac;1;<ts_ms>;<base64sig>", HMAC-SHA256 of `ts + "." + rawBody`,
// key base64-decoded, digest base64. Verified only when the secret is configured.
function verifySig(raw, header, secretB64) {
  try {
    const [scheme, version, ts, provided] = String(header || "").split(";");
    if (scheme !== "hmac" || version !== "1" || !ts || !provided) return false;
    if (Math.abs(Date.now() - Number(ts)) > 10 * 60 * 1000) return false; // 10-min replay window
    const key = Buffer.from(secretB64, "base64");
    const computed = crypto.createHmac("sha256", key).update(ts + "." + raw, "utf8").digest("base64");
    const a = Buffer.from(provided), b = Buffer.from(computed);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

const TRIAGE_SYSTEM = `You triage inbound TEXT MESSAGES to a pond/pool service business. Classify ONE text, reply STRICT JSON only:
{"kind":"lead"|"bill"|"other","confidence":0..1,"summary":"one plain sentence","lead":{"name":"","phone":"","service":"","message":""}}
"lead" = someone asking about service, a quote, availability, or a new customer inquiry. "bill" = a payment/collections text the business owes. Everything else (spam, codes, notifications) = "other". Never invent details.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, configured: { key: !!KEY, ai: aiConfigured(), sig: !!SIGN_SECRET } });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!KEY) return res.status(501).json({ error: "Server missing QUO_WEBHOOK_KEY", missingEnv: true });
  if (String((req.query || {}).key || "") !== KEY) return res.status(401).json({ error: "Unauthorized" });
  if (!SERVICE_KEY) return res.status(501).json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });

  const raw = await readRaw(req);
  if (SIGN_SECRET && !verifySig(raw, req.headers["openphone-signature"], SIGN_SECRET)) {
    return res.status(401).json({ error: "bad signature" });
  }
  let body; try { body = JSON.parse(raw || "{}"); } catch { return res.status(200).json({ ok: true, skipped: "unparseable" }); }

  // Storage/network failures return 5xx so Quo retries for up to three days; the unique inbox id
  // makes those retries harmless and prevents an inbound customer text from being acknowledged lost.
  const out = { ok: true };
  try {
    if (body.type && body.type !== "message.received") return res.status(200).json({ ok: true, skipped: body.type });
    const msg = (body.data && body.data.object) || {};
    // Fail SAFE: only ingest explicitly-incoming texts. Our OWN outbound sends ride this same
    // stream ("outgoing"), and a variant event that omits direction must NOT be re-ingested.
    if (String(msg.direction || "").toLowerCase() !== "incoming") return res.status(200).json({ ok: true, skipped: "not incoming" });
    const eventId = clean(body.id || msg.id, 80);
    if (!eventId) return res.status(200).json({ ok: true, skipped: "no id" });
    const id = `sms_${eventId}`;
    if (await inboxHas(id)) return res.status(200).json({ ok: true, duplicate: true });

    const fromPhone = clean(msg.from, 25);
    const text = clean(msg.text, 4000);
    if (!fromPhone) return res.status(200).json({ ok: true, skipped: "no from" });

    // Existing client? (match by phone, last-10 digits).
    const clients = await sbGet("sps_clients", []);
    const fp = last10(fromPhone);
    const client = fp ? (Array.isArray(clients) ? clients : []).find(c => last10(c.phone) === fp) : null;

    let kind = client ? "client" : "other", ai = client ? { summary: `Text from client ${client.name}`, clientId: String(client.id) } : null;
    // Hourly AI budget (separate key from email so channels don't starve each other) — text
    // spam to a business number is routine, so cap the spend + push noise. Over budget → the
    // text still stores as "other", it just doesn't bill or buzz. (Mirrors inbound-email.)
    let underBudget = true;
    if (!client && aiConfigured()) {
      const hourKey = new Date().toISOString().slice(0, 13);
      underBudget = false;
      try {
        await mutateAppState("sps_inbound_ai_budget_sms", (current) => {
          const budget = current && typeof current === "object" && !Array.isArray(current) ? current : {};
          const usedN = budget.h === hourKey ? (Number(budget.n) || 0) : 0;
          underBudget = false;
          if (usedN >= SMS_AI_HOURLY_CAP) return NO_APP_STATE_CHANGE;
          underBudget = true;
          return { ...budget, h: hourKey, n: usedN + 1 };
        });
      } catch (_) {
        // Fail closed on the paid AI call; the inbound text is still stored as "other" below.
        underBudget = false;
      }
    }
    if (!client && aiConfigured() && underBudget) {
      try {
        const reply = await callClaude({ system: TRIAGE_SYSTEM, content: `From: ${fromPhone}\n\n${text}`, maxTokens: 400, temperature: 0 });
        const j = extractJson(reply);
        if (j && ["lead", "bill", "other"].includes(j.kind)) { ai = j; kind = j.kind; }
      } catch (_) { /* AI down → "other" */ }
    }

    const row = {
      id, channel: "sms", from_phone: fromPhone,
      from_name: client ? client.name : fmtPhone(fromPhone),
      from_email: fmtPhone(fromPhone), // display fallback for the inbox row
      subject: text.slice(0, 80) || "(text message)",
      body_text: text, body_html: "", message_id: eventId, kind, ai, lead_id: "", read: false, replied: false,
    };
    const ir = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?on_conflict=id`, {
      method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify([row]),
    });
    if (!ir.ok) {
      const t = await ir.text().catch(() => "");
      out.stored = false;
      out.error = /relation .*sps_inbox|column|42P01|PGRST/i.test(t) ? "sps_inbox missing the channel/from_phone columns — run the SQL in CLAUDE.md" : t.slice(0, 200);
      return res.status(502).json(out); // 5xx → Quo retries once the columns exist
    }
    out.stored = true; out.kind = kind;

    // Owner push — a client's text or a fresh lead.
    if (kind === "lead") {
      const who = (ai && ai.lead && ai.lead.name) || fmtPhone(fromPhone);
      out.push = await pushOwner("new_lead", `Text lead: ${who}`, text.slice(0, 180) || "Open Comms → Email", "comms", { collapseId: `sms-${eventId}` });
    } else if (client) {
      out.push = await pushOwner("client_message", `Text from ${client.name}`, text.slice(0, 180), "comms", { collapseId: `sms-${eventId}` });
    }
  } catch (e) {
    out.ok = false; out.error = String((e && e.message) || e);
    return res.status(500).json(out);
  }
  return res.status(200).json(out);
}
