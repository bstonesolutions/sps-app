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

import { brandLogoSource } from "../brandAssets.js";

const escapeHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const absoluteLogoSource = (branding) => brandLogoSource(branding, {
  absolute: true,
  publicUrl: process.env.PUBLIC_APP_URL || "https://spsway.app",
});

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function buildHtml({ branding = {}, heading, message, rows = [], photosHtml = "", actionUrl = "", actionLabel = "", footerHtml = "", logoSrc = "" }) {
  const accent = /^#?[0-9a-fA-F]{3,8}$/.test(branding.accent || "") ? branding.accent : "#B81D24";
  const company = escapeHtml(branding.companyName || "Stone Property Solutions");
  // Wrap phone/email as explicitly white, non-underlined links so Apple Mail doesn't
  // auto-detect them and render blue underlined "links" — they read as plain text.
  const noLink = "color:#fff;text-decoration:none";
  const contactBits = [
    branding.companyPhone ? `<a href="tel:${escapeHtml(String(branding.companyPhone).replace(/[^\d+]/g, ""))}" style="${noLink}">${escapeHtml(branding.companyPhone)}</a>` : "",
    branding.companyEmail ? `<a href="mailto:${escapeHtml(branding.companyEmail)}" style="${noLink}">${escapeHtml(branding.companyEmail)}</a>` : "",
    branding.companyAddress ? `<span style="${noLink}">${escapeHtml(branding.companyAddress)}</span>` : "",
  ].filter(Boolean).join(" &middot; ");
  const rowsHtml = (rows || []).filter(Boolean).map(([k, v]) => `<tr>
      <td style="padding:6px 0;font-size:13px;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>
      <td style="padding:6px 0 6px 14px;font-size:13px;color:#111827;font-weight:700;vertical-align:top">${escapeHtml(v)}</td>
    </tr>`).join("");
  // Always use a real image. If a caller omits branding, the canonical hosted app icon
  // keeps transactional and notification emails consistent with the installed app.
  const resolvedLogoSrc = logoSrc || absoluteLogoSource(branding);
  const logoTile = `<img src="${escapeHtml(resolvedLogoSrc)}" alt="${company}" width="40" height="40" style="width:40px;height:40px;border-radius:11px;background:#fff;object-fit:contain;display:block;flex-shrink:0" />`;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:8px;color:#111827">
    <div style="background:${accent};border-radius:14px 14px 0 0;padding:18px 20px;color:#fff;display:flex;align-items:center;gap:12px">
      ${logoTile}
      <div>
        <div style="font-size:17px;font-weight:800">${company}</div>
        ${contactBits ? `<div style="font-size:11px;opacity:0.85;margin-top:2px">${contactBits}</div>` : ""}
      </div>
    </div>
    <div style="border:1px solid #eef0f2;border-top:none;border-radius:0 0 14px 14px;padding:20px">
      ${heading ? `<div style="font-size:16px;font-weight:800;margin-bottom:10px">${escapeHtml(heading)}</div>` : ""}
      ${message ? `<div style="font-size:14px;color:#374151;line-height:1.5;white-space:pre-wrap">${escapeHtml(message)}</div>` : ""}
      ${rowsHtml ? `<table style="width:100%;border-collapse:collapse;margin-top:14px;border-top:1px solid #eef0f2;padding-top:6px">${rowsHtml}</table>` : ""}
      ${actionUrl ? `<div style="margin-top:18px"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:10px;font-size:14px">${escapeHtml(actionLabel || "Open in the app")}</a></div>` : ""}
      ${photosHtml || ""}
    </div>
    ${footerHtml || ""}
  </div>`;
}

import { resolveFrom } from "./_sender.js";
import { requireUser } from "./_auth.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({ ok: true, endpoint: "send-notification", configured: { resend: !!process.env.RESEND_API_KEY } });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const _u = await requireUser(req, res);
  if (!_u) return;

  const { to, subject, heading, message, rows = [], branding = {}, photos = [], actionUrl = "", actionLabel = "" } = req.body || {};
  if (!to || !/.+@.+\..+/.test(to)) return res.status(400).json({ error: "A valid recipient email is required" });
  if (!subject) return res.status(400).json({ error: "A subject is required" });

  // Test/launch safety — enforced server-side. "hold" sends nothing; "redirect" sends to
  // the owner, tagged [TEST → …]. (Owner-alert emails already go to the owner, so redirect
  // is effectively a no-op for them beyond the tag.)
  const tm = req.body.testMode;
  let recipient = to, subjectPrefix = "";
  if (tm && tm.on) {
    if (tm.mode === "hold") return res.status(200).json({ sent: false, held: true, testMode: true });
    if (tm.to && /.+@.+\..+/.test(tm.to)) { recipient = tm.to; subjectPrefix = `[TEST → ${to}] `; }
    else return res.status(200).json({ sent: false, held: true, testMode: true, reason: "No test redirect email set." });
  }

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
      const at = (ph && typeof ph === "object" && ph.at) ? String(ph.at) : "";
      attachments.push({ filename: `${label ? label.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" : ""}photo-${i + 1}.${ext}`, content: m[2], content_type: m[1], content_id: cid });
      // Caption UNDER the photo, prominent — label (+ time when known).
      photoBlocks.push(`<div style="margin-bottom:18px"><img src="cid:${cid}" alt="${escapeHtml(label || "Service photo")}" style="width:100%;max-width:520px;border-radius:10px;display:block;border:1px solid #eef0f2" />${(label || at) ? `<div style="font-size:13px;font-weight:800;color:#111827;margin-top:7px">${escapeHtml(label || "Photo")}${at ? ` <span style="font-weight:500;color:#6b7280">&middot; ${escapeHtml(at)}</span>` : ""}</div>` : ""}</div>`);
    });
    const photosHtml = photoBlocks.length ? `<div style="margin-top:16px;border-top:1px solid #eef0f2;padding-top:14px"><div style="font-size:14px;font-weight:800;margin-bottom:10px">Photos</div>${photoBlocks.join("")}</div>` : "";

    // Optional CAN-SPAM unsubscribe footer (broadcasts/marketing). Only present when the caller
    // passes `unsubscribe: { email, address }` — owner alerts + transactional sends never do, so their
    // output is unchanged. Renders a plain footer (identity + a working opt-out contact + postal
    // address) AND sets a List-Unsubscribe mailto header so Gmail/Apple show a native unsubscribe.
    const unsub = req.body.unsubscribe;
    let footerHtml = "", listUnsub = "";
    if (unsub && (unsub.email || unsub.address)) {
      const uEmail = String(unsub.email || "").trim();
      const uAddr = String(unsub.address || branding.companyAddress || "").trim();
      const uCompany = escapeHtml(branding.companyName || "Stone Property Solutions");
      const optOut = uEmail
        ? `To stop these updates, reply to this email or contact <a href="mailto:${escapeHtml(uEmail)}?subject=Unsubscribe" style="color:#9ca3af">${escapeHtml(uEmail)}</a>.`
        : `To stop these updates, reply to this email.`;
      footerHtml = `<div style="max-width:560px;margin:12px auto 0;padding:0 10px;font-size:11px;color:#9ca3af;line-height:1.55;text-align:center">
        You're receiving this because you're a customer of ${uCompany}.<br>${optOut}${uAddr ? `<br>${escapeHtml(uAddr)}` : ""}
      </div>`;
      if (uEmail) listUnsub = `<mailto:${uEmail}?subject=Unsubscribe>`;
    }

    // Use the real logo when supplied and the canonical hosted app icon otherwise.
    // Data images are CID attachments for broad email-client support.
    let logoSrc = "";
    const li = absoluteLogoSource(branding);
    const lm = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(li || "");
    if (lm) {
      const ext = (lm[1].split("/")[1] || "png").replace("jpeg", "jpg");
      attachments.push({ filename: `logo.${ext}`, content: lm[2], content_type: lm[1], content_id: "splogo@sps" });
      logoSrc = "cid:splogo@sps";
    } else if (/^https?:\/\//i.test(li)) logoSrc = li;

    const html = buildHtml({ branding, heading: heading || subject, message, rows, photosHtml, actionUrl, actionLabel, footerHtml, logoSrc });
    const textLines = [heading || subject, "", message || ""];
    (rows || []).filter(Boolean).forEach(([k, v]) => textLines.push(`${k}: ${v}`));
    if (photoBlocks.length) textLines.push("", `(${photoBlocks.length} photo${photoBlocks.length > 1 ? "s" : ""} attached)`);
    if (unsub && (unsub.email || unsub.address)) textLines.push("", `To stop these updates, reply to this email${unsub.email ? ` or contact ${unsub.email}` : ""}.`);
    const text = textLines.join("\n");

    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [recipient], subject: subjectPrefix + subject, html, text, ...(attachments.length ? { attachments } : {}), ...(listUnsub ? { headers: { "List-Unsubscribe": listUnsub } } : {}) }),
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
