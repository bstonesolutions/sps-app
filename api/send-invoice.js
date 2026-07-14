// api/send-invoice.js
// Emails a client a full invoice (line items, totals, due date, terms, pay link)
// through Resend, using the business's branding.
//
// Required env (set in Vercel): RESEND_API_KEY
// Optional env: RESEND_FROM (defaults to the verified SPS domain address)

import { brandLogoSource } from "../brandAssets.js";

const escapeHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n) => "$" + (Number(n) || 0).toFixed(2);

const absoluteLogoSource = (branding) => brandLogoSource(branding, {
  absolute: true,
  publicUrl: process.env.PUBLIC_APP_URL || "https://spsway.app",
});

const logoImage = (src, company) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(company || "Stone Property Solutions")}" width="40" height="40" style="width:40px;height:40px;border-radius:11px;object-fit:contain;background:#fff;display:block;flex-shrink:0" />`;

function buildInvoiceHtml({ clientName, branding, invoice, payLink, intro, logoHtml, appUrl }) {
  const accent = /^#?[0-9a-fA-F]{3,8}$/.test(branding.accent || "") ? branding.accent : "#B81D24";
  const company = escapeHtml(branding.companyName || "");
  const rows = (invoice.lineItems || []).map((li) => {
    const qty = Number(li.qty) || 0;
    const price = Number(li.unitPrice) || 0;
    const amount = qty * price;
    const note = li.bundleNote ? `<div style="font-size:12px;color:#6b7280">Includes: ${escapeHtml(li.bundleNote)}</div>` : "";
    const taxStar = li.taxable ? ' <span style="color:#9ca3af">*</span>' : "";
    return `<tr>
      <td style="padding:9px 0;border-bottom:1px solid #eef0f2;vertical-align:top">
        <div style="font-size:14px;color:#111827">${escapeHtml(li.desc || "—")}${taxStar}</div>
        <div style="font-size:12px;color:#6b7280">${qty} × ${money(price)}</div>${note}
      </td>
      <td style="padding:9px 0;border-bottom:1px solid #eef0f2;text-align:right;font-size:14px;color:#111827;white-space:nowrap;vertical-align:top">${money(amount)}</td>
    </tr>`;
  }).join("");

  const totalRow = (label, value, opts = {}) => `<tr>
    <td style="padding:3px 0;font-size:${opts.big ? 17 : 13}px;${opts.big ? "font-weight:800;color:#111827" : "color:#6b7280"}">${escapeHtml(label)}</td>
    <td style="padding:3px 0;text-align:right;font-size:${opts.big ? 17 : 13}px;${opts.big ? "font-weight:800;color:" + accent : "color:#374151"};white-space:nowrap">${value}</td>
  </tr>`;

  // Wrap phone/email as explicitly white, non-underlined links so Apple Mail doesn't
  // auto-detect them and render blue underlined "links" — they read as plain text.
  const _noLink = "color:#fff;text-decoration:none";
  const contactBits = [
    branding.companyPhone ? `<a href="tel:${escapeHtml(String(branding.companyPhone).replace(/[^\d+]/g, ""))}" style="${_noLink}">${escapeHtml(branding.companyPhone)}</a>` : "",
    branding.companyEmail ? `<a href="mailto:${escapeHtml(branding.companyEmail)}" style="${_noLink}">${escapeHtml(branding.companyEmail)}</a>` : "",
    branding.companyAddress ? `<span style="${_noLink}">${escapeHtml(branding.companyAddress)}</span>` : "",
  ].filter(Boolean).join(" &middot; ");

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:8px;color:#111827">
    <div style="background:${accent};border-radius:14px 14px 0 0;padding:18px 20px;color:#fff;display:flex;align-items:center;gap:12px">
      ${logoHtml || logoImage(absoluteLogoSource(branding), branding.companyName)}
      <div>
        <div style="font-size:17px;font-weight:800">${company}</div>
        ${contactBits ? `<div style="font-size:11px;opacity:0.85;margin-top:2px">${contactBits}</div>` : ""}
      </div>
    </div>
    <div style="border:1px solid #eef0f2;border-top:none;border-radius:0 0 14px 14px;padding:20px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#9ca3af">Invoice</div>
          <div style="font-size:18px;font-weight:800">${escapeHtml(invoice.number || "")}</div>
        </div>
        <div style="text-align:right;font-size:12px;color:#6b7280">
          <div>Issued: <b style="color:#111827">${escapeHtml(invoice.date || "")}</b></div>
          <div>Due: <b style="color:#111827">${escapeHtml(invoice.dueDate || "")}</b></div>
        </div>
      </div>
      <div style="font-size:13px;color:#374151;margin-top:12px">Hi ${escapeHtml((clientName || "").split(" ")[0] || clientName || "there")},</div>
      <div style="font-size:13px;color:#374151;margin:6px 0 14px">${intro ? escapeHtml(intro) : ("Here's your invoice from " + company + ".")}</div>
      <table style="width:100%;border-collapse:collapse">${rows || `<tr><td style="font-size:13px;color:#6b7280;padding:8px 0">No line items.</td></tr>`}</table>
      <table style="width:100%;border-collapse:collapse;margin-top:12px">
        ${Number(invoice.discountTotal) > 0 ? totalRow("Discount", "−" + money(invoice.discountTotal)) : ""}
        ${totalRow("Subtotal", money(invoice.subtotal))}
        ${totalRow(`Tax${invoice.taxRate ? ` (${invoice.taxRate}%)` : ""}`, money(invoice.tax))}
        ${totalRow("Total Due", money(invoice.total), { big: true })}
      </table>
      ${payLink ? `<div style="text-align:center;margin-top:20px">
        <a href="${escapeHtml(payLink)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:800;padding:14px 30px;border-radius:12px;font-size:15px">Pay Invoice Online</a>
      </div>` : ""}
      ${appUrl ? `<div style="text-align:center;margin-top:11px">
        <a href="${escapeHtml(appUrl)}" style="display:inline-block;color:${accent};text-decoration:none;font-weight:700;font-size:13.5px">Or pay in the ${company} app &rarr;</a>
      </div>` : ""}
      ${invoice.terms ? `<div style="font-size:12px;color:#6b7280;margin-top:18px;line-height:1.5;border-top:1px solid #eef0f2;padding-top:12px">${escapeHtml(invoice.terms)}</div>` : ""}
    </div>
  </div>`;
}

function buildInvoiceText({ clientName, branding, invoice, payLink, intro }) {
  const lines = [];
  lines.push(`Invoice ${invoice.number || ""} from ${branding.companyName || ""}`);
  if (intro) { lines.push(""); lines.push(intro); }
  lines.push("");
  (invoice.lineItems || []).forEach((li) => {
    const qty = Number(li.qty) || 0, price = Number(li.unitPrice) || 0;
    lines.push(`- ${li.desc || "—"}  (${qty} x ${money(price)})  ${money(qty * price)}`);
  });
  lines.push("");
  if (Number(invoice.discountTotal) > 0) lines.push(`Discount: -${money(invoice.discountTotal)}`);
  lines.push(`Subtotal: ${money(invoice.subtotal)}`);
  lines.push(`Tax${invoice.taxRate ? ` (${invoice.taxRate}%)` : ""}: ${money(invoice.tax)}`);
  lines.push(`Total Due: ${money(invoice.total)}`);
  lines.push(`Due date: ${invoice.dueDate || ""}`);
  if (payLink) { lines.push(""); lines.push(`View & pay: ${payLink}`); }
  if (invoice.terms) { lines.push(""); lines.push(invoice.terms); }
  return lines.join("\n");
}

import { resolveFrom } from "./_sender.js";
import { requireUser } from "./_auth.js";

// CORS so the native app (capacitor://localhost) can POST cross-origin to the absolute
// PROD_URL. Without this the native invoice send fails as "couldn't reach server".
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({ ok: true, endpoint: "send-invoice", configured: { resend: !!process.env.RESEND_API_KEY } });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const _u = await requireUser(req, res);
  if (!_u) return;

  const { to, clientName, branding = {}, invoice = {}, payLink, emailSubject, emailIntro } = req.body || {};
  if (!to || !/.+@.+\..+/.test(to)) return res.status(400).json({ error: "A valid client email is required" });

  // Test/launch safety — enforced server-side so a forgotten call site can't leak to a
  // real client. "hold" sends nothing; "redirect" sends to the owner, tagged [TEST → …].
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
    const subject = subjectPrefix + ((emailSubject && String(emailSubject).trim()) || `Invoice ${invoice.number || ""} from ${branding.companyName || "your service provider"}`.trim());

    // Embed an uploaded data-image as a CID attachment. Relative/missing images use the
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
    const appUrl = (typeof req.body.appUrl === "string" && req.body.appUrl) ? req.body.appUrl : "spsway://invoices";
    const html = buildInvoiceHtml({ clientName, branding, invoice, payLink, intro: emailIntro, logoHtml, appUrl });
    const text = buildInvoiceText({ clientName, branding, invoice, payLink, intro: emailIntro });

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
    return res.status(500).json({ error: err.message || "Failed to send invoice" });
  }
}
