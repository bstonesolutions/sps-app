// api/send-estimate.js
// Emails a client a branded estimate (line items, total, notes, validity, approve CTA) through Resend,
// with the business's REAL logo inlined (cid, monogram fallback) and the estimate PDF attached so the
// client can save it to their phone/computer. Modeled on send-invoice.js.
//
// Required env (set in Vercel): RESEND_API_KEY
// Optional env: RESEND_FROM (defaults to the verified SPS domain address)

import { resolveFrom } from "./_sender.js";
import { requireUser } from "./_auth.js";

const escapeHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n) => "$" + (Number(n) || 0).toFixed(2);

function buildEstimateHtml({ clientName, branding, estimate, logoHtml }) {
  const accent = /^#?[0-9a-fA-F]{3,8}$/.test(branding.accent || "") ? branding.accent : "#B81D24";
  const company = escapeHtml(branding.companyName || "");
  const initial = escapeHtml((((branding.companyName || "Stone Property Solutions").trim())[0] || "S").toUpperCase());
  const items = Array.isArray(estimate.items) ? estimate.items : [];
  const rows = items.filter((it) => (it.desc || "").trim()).map((it) => {
    const qty = Number(it.qty) || 1;
    const price = Number(it.price) || 0;
    const amount = qty * price;
    const qtyBit = qty !== 1 ? `<div style="font-size:12px;color:#6b7280">${qty} &times; ${money(price)}</div>` : "";
    return `<tr>
      <td style="padding:9px 0;border-bottom:1px solid #eef0f2;vertical-align:top">
        <div style="font-size:14px;color:#111827">${escapeHtml(it.desc || "—")}</div>${qtyBit}
      </td>
      <td style="padding:9px 0;border-bottom:1px solid #eef0f2;text-align:right;font-size:14px;color:#111827;white-space:nowrap;vertical-align:top">${money(amount)}</td>
    </tr>`;
  }).join("");

  const totalStr = (typeof estimate.total === "string" && estimate.total.trim().startsWith("$"))
    ? estimate.total
    : money(estimate.total != null && estimate.total !== "" ? estimate.total : items.reduce((s, it) => s + (Number(it.qty) || 1) * (Number(it.price) || 0), 0));

  const _noLink = "color:#fff;text-decoration:none";
  const contactBits = [
    branding.companyPhone ? `<a href="tel:${escapeHtml(String(branding.companyPhone).replace(/[^\d+]/g, ""))}" style="${_noLink}">${escapeHtml(branding.companyPhone)}</a>` : "",
    branding.companyEmail ? `<a href="mailto:${escapeHtml(branding.companyEmail)}" style="${_noLink}">${escapeHtml(branding.companyEmail)}</a>` : "",
    branding.companyAddress ? `<span style="${_noLink}">${escapeHtml(branding.companyAddress)}</span>` : "",
  ].filter(Boolean).join(" &middot; ");
  const phoneDigits = String(branding.companyPhone || "").replace(/[^\d+]/g, "");

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:8px;color:#111827">
    <div style="background:${accent};border-radius:14px 14px 0 0;padding:18px 20px;color:#fff;display:flex;align-items:center;gap:12px">
      ${logoHtml || `<div style="width:40px;height:40px;border-radius:11px;background:#fff;text-align:center;line-height:40px;flex-shrink:0;font-size:21px;font-weight:800;color:${accent}">${initial}</div>`}
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
      <table style="width:100%;border-collapse:collapse;margin-top:6px">
        <tr>
          <td style="padding:10px 0 0;font-size:17px;font-weight:800;color:#111827">Total</td>
          <td style="padding:10px 0 0;text-align:right;font-size:17px;font-weight:800;color:${accent};white-space:nowrap">${escapeHtml(totalStr)}</td>
        </tr>
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
  const lines = [];
  lines.push(`Estimate from ${branding.companyName || ""}`.trim());
  if (estimate.service) lines.push(`Service: ${estimate.service}`);
  lines.push("");
  (Array.isArray(estimate.items) ? estimate.items : []).filter((it) => (it.desc || "").trim()).forEach((it) => {
    const qty = Number(it.qty) || 1, price = Number(it.price) || 0;
    lines.push(`- ${it.desc}  ${money(qty * price)}`);
  });
  lines.push("");
  const totalStr = (typeof estimate.total === "string" && estimate.total.trim().startsWith("$")) ? estimate.total : money(estimate.total);
  lines.push(`Total: ${totalStr}`);
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

    // Inline the real uploaded logo as a cid attachment (reliable across mail clients); monogram fallback.
    const attachments = [];
    let logoHtml = "";
    const li = branding.logoImage || "";
    if (branding.logoType === "image" && li) {
      const lm = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(li);
      if (lm) {
        const ext = (lm[1].split("/")[1] || "png").replace("jpeg", "jpg");
        attachments.push({ filename: `logo.${ext}`, content: lm[2], content_type: lm[1], content_id: "splogo@sps" });
        logoHtml = `<img src="cid:splogo@sps" alt="" style="width:40px;height:40px;border-radius:11px;object-fit:cover;background:#fff;flex-shrink:0" />`;
      } else if (/^https?:\/\//i.test(li)) {
        logoHtml = `<img src="${escapeHtml(li)}" alt="" style="width:40px;height:40px;border-radius:11px;object-fit:cover;background:#fff;flex-shrink:0" />`;
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
