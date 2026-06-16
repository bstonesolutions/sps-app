// api/send-notification.js
// Sends the business owner a branded notification email (e.g. a client upgrade
// request) through Resend. Generic: pass a subject + message, plus optional
// label/value rows. Used by the in-app Owner Alerts routing.
//
// Required env (set in Vercel): RESEND_API_KEY
// Optional env: RESEND_FROM (defaults to the verified SPS domain address)
//
// CORS is permissive so the native app (capacitor://localhost) can call it
// cross-origin via the absolute PROD_URL; the web build calls it same-origin.

const escapeHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function buildHtml({ branding = {}, heading, message, rows = [], photosHtml = "" }) {
  const accent = /^#?[0-9a-fA-F]{3,8}$/.test(branding.accent || "") ? branding.accent : "#B81D24";
  const company = escapeHtml(branding.companyName || "Stone Property Solutions");
  const contactBits = [branding.companyPhone, branding.companyEmail, branding.companyAddress]
    .filter(Boolean).map(escapeHtml).join(" &middot; ");
  const rowsHtml = (rows || []).filter(Boolean).map(([k, v]) => `<tr>
      <td style="padding:6px 0;font-size:13px;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>
      <td style="padding:6px 0 6px 14px;font-size:13px;color:#111827;font-weight:700;vertical-align:top">${escapeHtml(v)}</td>
    </tr>`).join("");
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:8px;color:#111827">
    <div style="background:${accent};border-radius:14px 14px 0 0;padding:18px 20px;color:#fff">
      <div style="font-size:17px;font-weight:800">${company}</div>
      ${contactBits ? `<div style="font-size:11px;opacity:0.85;margin-top:3px">${contactBits}</div>` : ""}
    </div>
    <div style="border:1px solid #eef0f2;border-top:none;border-radius:0 0 14px 14px;padding:20px">
      ${heading ? `<div style="font-size:16px;font-weight:800;margin-bottom:10px">${escapeHtml(heading)}</div>` : ""}
      ${message ? `<div style="font-size:14px;color:#374151;line-height:1.5;white-space:pre-wrap">${escapeHtml(message)}</div>` : ""}
      ${rowsHtml ? `<table style="width:100%;border-collapse:collapse;margin-top:14px;border-top:1px solid #eef0f2;padding-top:6px">${rowsHtml}</table>` : ""}
      ${photosHtml || ""}
    </div>
  </div>`;
}

import { resolveFrom } from "./_sender.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({ ok: true, endpoint: "send-notification", configured: { resend: !!process.env.RESEND_API_KEY } });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { to, subject, heading, message, rows = [], branding = {}, photos = [] } = req.body || {};
  if (!to || !/.+@.+\..+/.test(to)) return res.status(400).json({ error: "A valid recipient email is required" });
  if (!subject) return res.status(400).json({ error: "A subject is required" });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = resolveFrom(req.body, process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>");
  if (!RESEND_KEY) return res.status(501).json({ error: "Email delivery is not configured on the server.", missingEnv: true });

  try {
    // Embed any provided photos (base64 data URLs) as inline cid attachments referenced
    // from the HTML, so the report email shows the pictures (and they're downloadable too).
    const attachments = [];
    const photoBlocks = [];
    (Array.isArray(photos) ? photos : []).slice(0, 12).forEach((ph, i) => {
      const src = typeof ph === "string" ? ph : (ph && ph.src) || "";
      const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(src || "");
      if (!m) return;
      const ext = (m[1].split("/")[1] || "jpg").replace("jpeg", "jpg");
      const cid = `photo${i}@sps`;
      const label = (ph && typeof ph === "object" && ph.label) ? String(ph.label) : "";
      attachments.push({ filename: `${label ? label.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" : ""}photo-${i + 1}.${ext}`, content: m[2], content_type: m[1], content_id: cid });
      photoBlocks.push(`<div style="margin-bottom:12px">${label ? `<div style="font-size:11px;font-weight:700;color:#6b7280;margin-bottom:5px">${escapeHtml(label)}</div>` : ""}<img src="cid:${cid}" alt="${escapeHtml(label || "Service photo")}" style="width:100%;max-width:520px;border-radius:10px;display:block;border:1px solid #eef0f2" /></div>`);
    });
    const photosHtml = photoBlocks.length ? `<div style="margin-top:16px;border-top:1px solid #eef0f2;padding-top:14px"><div style="font-size:14px;font-weight:800;margin-bottom:10px">Photos</div>${photoBlocks.join("")}</div>` : "";

    const html = buildHtml({ branding, heading: heading || subject, message, rows, photosHtml });
    const textLines = [heading || subject, "", message || ""];
    (rows || []).filter(Boolean).forEach(([k, v]) => textLines.push(`${k}: ${v}`));
    if (attachments.length) textLines.push("", `(${attachments.length} photo${attachments.length > 1 ? "s" : ""} attached)`);
    const text = textLines.join("\n");

    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text, ...(attachments.length ? { attachments } : {}) }),
    });
    const sendData = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      const reason = sendData?.message || sendData?.error || `Resend error ${sendRes.status}`;
      return res.status(502).json({ error: reason, details: sendData });
    }
    return res.status(200).json({ sent: true, id: sendData.id || null });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to send notification" });
  }
}
