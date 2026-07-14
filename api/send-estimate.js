// api/send-estimate.js
// Emails a client a branded estimate (line items, total, notes, validity, approve CTA) through Resend,
// with the business's real logo inlined (and the app icon as a reliable fallback) and the estimate PDF attached so the
// client can save it to their phone/computer. Modeled on send-invoice.js.
//
// Required env (set in Vercel): RESEND_API_KEY
// Optional env: RESEND_FROM (defaults to the verified SPS domain address)

import { resolveFrom } from "./_sender.js";
import { requireUser } from "./_auth.js";
import { brandLogoSource } from "../brandAssets.js";
import { estimateLineAmount, estimateTotals, formatEstimateMoney } from "../estimateMath.js";

const escapeHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = formatEstimateMoney;

const absoluteLogoSource = (branding) => brandLogoSource(branding, {
  absolute: true,
  publicUrl: process.env.PUBLIC_APP_URL || "https://spsway.app",
});

const logoImage = (src, company) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(company || "Stone Property Solutions")}" width="40" height="40" style="width:40px;height:40px;border-radius:11px;object-fit:contain;background:#fff;display:block;flex-shrink:0" />`;

function buildEstimateHtml({ clientName, branding, estimate, logoHtml }) {
  const accent = /^#?[0-9a-fA-F]{3,8}$/.test(branding.accent || "") ? branding.accent : "#B81D24";
  const company = escapeHtml(branding.companyName || "");
  const items = Array.isArray(estimate.items) ? estimate.items : [];
  const totals = estimateTotals(estimate);
  const rows = items.filter((it) => (it.desc || "").trim()).map((it) => {
    const qty = Number(it.qty) || 1;
    const price = Number(it.price ?? it.unitPrice) || 0;
    const amount = estimateLineAmount(it);
    const qtyBit = qty !== 1 ? `<div style="font-size:12px;color:#6b7280">${qty} &times; ${money(price)}</div>` : "";
    return `<tr>
      <td style="padding:9px 0;border-bottom:1px solid #eef0f2;vertical-align:top">
        <div style="font-size:14px;color:#111827">${escapeHtml(it.desc || "—")}</div>${qtyBit}
      </td>
      <td style="padding:9px 0;border-bottom:1px solid #eef0f2;text-align:right;font-size:14px;color:#111827;white-space:nowrap;vertical-align:top">${money(amount)}</td>
    </tr>`;
  }).join("");

  const totalRow = (label, value, opts = {}) => `<tr>
    <td style="padding:${opts.big ? "10px 0 0" : "3px 0"};font-size:${opts.big ? 17 : 13}px;${opts.big ? "font-weight:800;color:#111827" : "color:#6b7280"}">${escapeHtml(label)}</td>
    <td style="padding:${opts.big ? "10px 0 0" : "3px 0"};text-align:right;font-size:${opts.big ? 17 : 13}px;${opts.big ? `font-weight:800;color:${accent}` : "color:#374151"};white-space:nowrap">${escapeHtml(value)}</td>
  </tr>`;

  const _noLink = "color:#fff;text-decoration:none";
  const contactBits = [
    branding.companyPhone ? `<a href="tel:${escapeHtml(String(branding.companyPhone).replace(/[^\d+]/g, ""))}" style="${_noLink}">${escapeHtml(branding.companyPhone)}</a>` : "",
    branding.companyEmail ? `<a href="mailto:${escapeHtml(branding.companyEmail)}" style="${_noLink}">${escapeHtml(branding.companyEmail)}</a>` : "",
    branding.companyAddress ? `<span style="${_noLink}">${escapeHtml(branding.companyAddress)}</span>` : "",
  ].filter(Boolean).join(" &middot; ");
  const phoneDigits = String(branding.companyPhone || "").replace(/[^\d+]/g, "");

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:8px;color:#111827">
    <div style="background:${accent};border-radius:14px 14px 0 0;padding:18px 20px;color:#fff;display:flex;align-items:center;gap:12px">
      ${logoHtml || logoImage(absoluteLogoSource(branding), branding.companyName)}
      <div>
        <div style="font-size:17px;font-weight:800">${company}</div>
        ${contactBits ? `<div style="font-size:11px;opacity:0.85;margin-top:2px">${contactBits}</div>` : ""}
      </div>
    </div>
    <div style="border:1px solid #eef0f2;border-top:none;border-radius:0 0 14px 14px;padding:20px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#9ca3af">Estimate</div>
      ${estimate.service ? `<div style="font-size:18px;font-weight:800;margin-top:2px">${escapeHtml(estimate.service)}</div>` : ""}
      <div style="font-size:13px;color:#374151;margin-top:12px">Hi ${escapeHtml((clientName || "").split(" ")[0] || clientName || "there")},</div>
      <div style="font-size:13px;color:#374151;margin:6px 0 14px">Here's your estimate from ${company}. A PDF copy is attached for your records.</div>
      <table style="width:100%;border-collapse:collapse">${rows || `<tr><td style="font-size:13px;color:#6b7280;padding:8px 0">No line items.</td></tr>`}</table>
      <table style="width:100%;border-collapse:collapse;margin-top:10px">
        ${totalRow("Subtotal", money(totals.subtotal))}
        ${totals.taxEnabled ? totalRow(`Sales tax${totals.taxRate ? ` (${totals.taxRate}%)` : ""}`, money(totals.tax)) : ""}
        ${totalRow("Total", money(totals.total), { big: true })}
      </table>
      ${estimate.notes ? `<div style="font-size:13px;color:#374151;margin-top:16px;line-height:1.55;background:#f8f8fa;border-radius:10px;padding:12px 14px"><b style="color:#111827">Notes</b><br>${escapeHtml(estimate.notes)}</div>` : ""}
      ${estimate.validDays ? `<div style="font-size:12px;color:#6b7280;margin-top:12px">Valid for ${escapeHtml(String(estimate.validDays))} days.</div>` : ""}
      <div style="text-align:center;margin-top:20px;background:#f8f8fa;border-radius:12px;padding:16px 14px">
        <div style="font-size:15px;font-weight:800;color:#111827">Ready to move forward?</div>
        <div style="font-size:13px;color:#6b7280;margin-top:5px;line-height:1.5">Reply <b style="color:${accent}">YES</b> to approve this estimate.${branding.companyPhone ? ` Questions? Call <a href="tel:${escapeHtml(phoneDigits)}" style="color:${accent};text-decoration:none;font-weight:700">${escapeHtml(branding.companyPhone)}</a>.` : ""}</div>
      </div>
    </div>
  </div>`;
}

function buildEstimateText({ clientName, branding, estimate }) {
  const totals = estimateTotals(estimate);
  const lines = [];
  lines.push(`Estimate from ${branding.companyName || ""}`.trim());
  if (estimate.service) lines.push(`Service: ${estimate.service}`);
  lines.push("");
  (Array.isArray(estimate.items) ? estimate.items : []).filter((it) => (it.desc || "").trim()).forEach((it) => {
    const qty = Number(it.qty) || 1, price = Number(it.price ?? it.unitPrice) || 0;
    lines.push(`- ${it.desc}${qty !== 1 ? `  (${qty} x ${money(price)})` : ""}  ${money(estimateLineAmount(it))}`);
  });
  lines.push("");
  lines.push(`Subtotal: ${money(totals.subtotal)}`);
  if (totals.taxEnabled) lines.push(`Sales tax${totals.taxRate ? ` (${totals.taxRate}%)` : ""}: ${money(totals.tax)}`);
  lines.push(`Total: ${money(totals.total)}`);
  if (estimate.notes) { lines.push(""); lines.push(`Notes: ${estimate.notes}`); }
  if (estimate.validDays) lines.push(`Valid for ${estimate.validDays} days.`);
  lines.push("");
  lines.push(`To approve, reply YES. Questions? Call ${branding.companyPhone || "us"}.`);
  lines.push("A PDF copy is attached to this email.");
  return lines.join("\n");
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({ ok: true, endpoint: "send-estimate", configured: { resend: !!process.env.RESEND_API_KEY } });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const _u = await requireUser(req, res);
  if (!_u) return;

  const { to, clientName, branding = {}, estimate = {}, emailSubject } = req.body || {};
  if (!to || !/.+@.+\..+/.test(to)) return res.status(400).json({ error: "A valid client email is required" });

  // Test/launch safety — enforced server-side (same as send-invoice). "hold" sends nothing;
  // "redirect" sends to the owner, tagged [TEST → …].
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
    const subject = subjectPrefix + ((emailSubject && String(emailSubject).trim()) || `Estimate from ${branding.companyName || "your service provider"}`.trim());

    // Inline an uploaded data-image as a CID attachment. Relative/missing images use the
    // canonical hosted app icon so every mail client gets the real SPS mark, never a monogram.
    const attachments = [];
    let logoHtml = "";
    const li = absoluteLogoSource(branding);
    if (li) {
      const lm = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(li);
      if (lm) {
        const ext = (lm[1].split("/")[1] || "png").replace("jpeg", "jpg");
        attachments.push({ filename: `logo.${ext}`, content: lm[2], content_type: lm[1], content_id: "splogo@sps" });
        logoHtml = logoImage("cid:splogo@sps", branding.companyName);
      } else if (/^https?:\/\//i.test(li)) {
        logoHtml = logoImage(li, branding.companyName);
      }
    }

    // The estimate PDF, generated client-side and passed as base64 so the client can save it.
    const pdf = req.body.pdf;
    if (pdf && typeof pdf.content === "string" && pdf.content) {
      const name = String(pdf.filename || "estimate.pdf").replace(/[\r\n"\\]+/g, " ").slice(0, 120);
      attachments.push({ filename: name.endsWith(".pdf") ? name : `${name}.pdf`, content: pdf.content, content_type: "application/pdf" });
    }

    const html = buildEstimateHtml({ clientName, branding, estimate, logoHtml });
    const text = buildEstimateText({ clientName, branding, estimate });

    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [recipient], subject, html, text, ...(attachments.length ? { attachments } : {}) }),
    });
    const sendData = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      const reason = sendData?.message || sendData?.error || `Resend error ${sendRes.status}`;
      return res.status(502).json({ error: reason, details: sendData });
    }
    return res.status(200).json({ sent: true, id: sendData.id || null });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to send estimate" });
  }
}
