// api/lead-intake.js
// Instant new-lead alert ("speed to lead"). The WEBSITE's Supabase project fires a Database Webhook
// on every `leads` INSERT → POSTs the row here → this texts/emails the owner immediately through
// the SAME sending settings every owner send uses (Owner Alerts number / reports email — see
// memory: wire-sends-to-existing-settings). It does NOT write the lead into the app — the app is
// the single writer of sps_leads and imports via api/leads-sync.js on open; this is purely the
// real-time ping so a hot lead never sits unnoticed.
//
// Auth: the webhook must send `Authorization: Bearer <LEAD_WEBHOOK_SECRET>` (set the same random
// string in Vercel and on the webhook). Payload: Supabase webhook shape { type:"INSERT", record }
// (a bare { name, phone, ... } object also works, for future sources).
//
// Env: LEAD_WEBHOOK_SECRET (required to accept posts), QUO_API_KEY + QUO_PHONE_NUMBER (text),
// RESEND_API_KEY (email), SUPABASE_SERVICE_ROLE_KEY (reads the sending settings).

import { pushOwner } from "./_push.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const QUO_KEY      = process.env.QUO_API_KEY;
const QUO_FROM     = process.env.QUO_PHONE_NUMBER;
const SECRET       = process.env.LEAD_WEBHOOK_SECRET;

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
function toE164(s) {
  const raw = String(s == null ? "" : s).trim();
  if (raw.startsWith("+")) return "+" + raw.slice(1).replace(/\D/g, "");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d ? "+" + d : "";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({ ok: true, configured: { secret: !!SECRET, quo: !!(QUO_KEY && QUO_FROM), resend: !!RESEND_KEY } });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SECRET) return res.status(501).json({ error: "LEAD_WEBHOOK_SECRET not set" });
  if ((req.headers.authorization || "") !== `Bearer ${SECRET}`) return res.status(401).json({ error: "unauthorized" });

  const body = req.body || {};
  // Only INSERTs alert — a webhook misconfigured with UPDATE/DELETE events (e.g. our own ack PATCH
  // flipping handled=true) must never fire "new lead" messages. 200 so Supabase doesn't retry.
  if (body.type && body.type !== "INSERT") return res.status(200).json({ ok: true, skipped: body.type });
  const rec = body.record || body; // Supabase webhook shape, or a bare lead object
  // Public-form input → strip control chars + collapse whitespace so nothing injects extra lines
  // into the SMS body or the email subject.
  const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").slice(0, n).trim();
  const name = clean(rec.name, 80) || "Someone";
  const service = clean(rec.service, 60);
  const phone = clean(rec.phone, 25);
  const emailAddr = clean(rec.email, 100);
  const msg = clean(rec.message, 160);

  const [email, cfgAll, branding] = await Promise.all([sbGet("sps_email", {}), sbGet("sps_schedule_cfg", {}), sbGet("sps_branding", {})]);
  const notify = email.notify || {}, tmode = email.testMode || {};
  const toPhone = notify.ownerPhone || tmode.phone || "";
  const toEmail = (cfgAll.ownerDigest && cfgAll.ownerDigest.to) || notify.ownerEmail || email.ownerEmail || branding.companyEmail || "";

  const bits = [service, phone, emailAddr].filter(Boolean).join(" · ");
  const text = `🔔 New website lead: ${name}${bits ? ` — ${bits}` : ""}${msg ? `. “${msg}”` : ""}. It's waiting in Comms → Leads.\nOpen in app: spsway://leads\nBrowser: https://spsway.app/?open=leads`;

  const out = {};
  // Same "from" resolution as the app's texts (api/send-sms): the configured Sending Identity
  // texting number first, then the server default — so this alert comes from the same line.
  const toNum = toE164(toPhone), fromNum = toE164(email.textingNumber) || toE164(QUO_FROM);
  if (!toNum) out.sms = { ok: false, skipped: "no owner cell set — add yours in Comms → Settings" };
  else if (toNum === fromNum) out.sms = { ok: false, skipped: "owner cell matches the business line" };
  else if (QUO_KEY && fromNum) {
    try {
      const r = await fetch("https://api.quo.com/v1/messages", {
        method: "POST", headers: { Authorization: QUO_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, from: fromNum, to: [toNum] }),
      });
      out.sms = { ok: r.ok };
    } catch { out.sms = { ok: false }; }
  }
  if (RESEND_KEY && /.+@.+\..+/.test(toEmail)) {
    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Photos/videos the lead attached (public bucket URLs) — images render inline; videos link out.
    const media = (Array.isArray(rec.photos) ? rec.photos : []).filter((u) => typeof u === "string" && /^https:\/\//i.test(u)).slice(0, 6);
    const isVideo = (u) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u);
    const mediaHtml = media.length ? `
      <div style="margin-top:14px;">
        ${media.filter((u) => !isVideo(u)).map((u) => `<img src="${esc(u)}" width="100%" style="display:block;max-width:494px;border-radius:12px;border:1px solid #e8e5e0;margin:0 0 10px;" alt="Lead photo" />`).join("")}
        ${media.filter(isVideo).map((u) => `<a href="${esc(u)}" style="display:block;font-size:13px;font-weight:700;color:#B81D24;margin:0 0 8px;">▶ View attached video</a>`).join("")}
      </div>` : "";
    // One-tap replies + the app button (deep-links straight to Comms → Leads).
    const quick = [
      phone ? `<a href="tel:${esc(phone)}" style="color:#B81D24;font-weight:700;text-decoration:none;">📞 Call</a>` : "",
      phone ? `<a href="sms:${esc(phone)}" style="color:#B81D24;font-weight:700;text-decoration:none;">💬 Text</a>` : "",
      emailAddr ? `<a href="mailto:${esc(emailAddr)}" style="color:#B81D24;font-weight:700;text-decoration:none;">✉️ Reply</a>` : "",
    ].filter(Boolean).join(" &nbsp;·&nbsp; ");
    const html = `<div style="max-width:520px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
      <div style="font-size:17px;font-weight:800;color:#26211C;margin-bottom:12px;">🔔 New website lead</div>
      <div style="background:#faf9f7;border:1px solid #e8e5e0;border-radius:14px;padding:18px;font-size:14px;line-height:1.7;color:#26211C;">
        <b style="font-size:16px;">${esc(name)}</b>${service ? `<br/>Service: <b>${esc(service)}</b>` : ""}${phone ? `<br/>Phone: ${esc(phone)}` : ""}${emailAddr ? `<br/>Email: ${esc(emailAddr)}` : ""}
        ${msg ? `<div style="margin-top:12px;padding:12px 14px;background:#fff;border-left:3px solid #B81D24;border-radius:8px;font-size:15px;">“${esc(msg)}”</div>` : ""}
        ${mediaHtml}
        ${quick ? `<div style="margin-top:14px;font-size:14px;">${quick}</div>` : ""}
      </div>
      <a href="spsway://leads" style="display:block;background:#B81D24;color:#ffffff;text-align:center;font-weight:800;font-size:15px;padding:15px 20px;border-radius:12px;text-decoration:none;margin-top:16px;">📱 Open in the SPS app</a>
      <a href="https://spsway.app/?open=leads" style="display:block;background:#ffffff;border:1.5px solid #B81D24;color:#B81D24;text-align:center;font-weight:800;font-size:15px;padding:13px 20px;border-radius:12px;text-decoration:none;margin-top:10px;">🌐 Open in the browser</a>
      <div style="font-size:12px;color:#8a857e;margin-top:12px;text-align:center;">Reply fast, win the job.</div>
    </div>`;
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>", to: [toEmail], subject: `New lead: ${name}${service ? ` — ${service}` : ""}`, html, text }),
      });
      out.email = { ok: r.ok };
    } catch { out.email = { ok: false }; }
  }
  // Comms → Log entries for the alert sends. SECURITY: the log table is readable by any
  // authenticated session until the RLS lockdown — record the lead's NAME only (no phone/
  // email/message) and "you" instead of the owner's personal contact.
  const logIt = (channel, ok) =>
    fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, {
      method: "POST", headers: sbHeaders(),
      body: JSON.stringify({ client_id: "", type: "Lead alert", channel, body: `New lead: ${name}${service ? ` — ${service}` : ""} (details in Comms → Leads)`, ok: !!ok, origin: "new-lead alert (website webhook)", recipient: "you" }),
    }).catch(() => {});
  try {
    if (out.sms) await logIt("sms", out.sms.ok);
    if (out.email) await logIt("email", out.email.ok);
  } catch { /* best-effort */ }

  // Native push to the owner's devices — best-effort mirror of the text/email above.
  out.push = await pushOwner("new_lead", `New lead: ${name}`,
    `${bits ? `${bits}. ` : ""}${msg ? `“${msg}”` : "Waiting in Comms → Leads."}`, "leads", { email });

  // Always 200 once authorized — Supabase retries non-2xx, and a notify hiccup must not re-fire
  // (the lead itself is safe in the website table; the app imports it on next open regardless).
  return res.status(200).json({ ok: true, ...out });
}
