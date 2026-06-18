// api/send-test-email.js
// Sends a simple branded "integration test" email via Resend so the Sync/Status tab
// can prove end-to-end email DELIVERY (not just that a key is present). Does not touch
// Supabase or mint any sign-in link — it's purely a delivery probe.
//
// Required env (set in Vercel): RESEND_API_KEY
// Optional env: RESEND_FROM

const COMPANY = "Stone Property Solutions";
const CRIMSON = "#B81D24";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const escapeHtml = (s) => String(s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

import { resolveFrom } from "./_sender.js";
import { requireUser } from "./_auth.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const KEY  = process.env.RESEND_API_KEY;
  const FROM = process.env.RESEND_FROM || `${COMPANY} <noreply@stonepropertysolutions.com>`;

  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({ ok: true, endpoint: "send-test-email", configured: { resend: !!KEY }, from: FROM });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const _u = await requireUser(req, res);
  if (!_u) return;

  if (!KEY) return res.status(501).json({ error: "Email is not configured on the server.", missingEnv: true });

  const { to } = req.body || {};
  if (!to || !/.+@.+\..+/.test(to)) return res.status(400).json({ error: "A valid recipient email is required." });

  // Mirror real-send From resolution (same as send-invoice.js): honor body.fromName/fromAddress
  // when on the verified domain, else fall back to the env default.
  const SEND_FROM = resolveFrom(req.body, FROM);

  const when = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" style="max-width:460px;width:100%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
        <tr><td style="background:${CRIMSON};padding:22px 26px;text-align:center;color:#fff;font-size:18px;font-weight:800;">${escapeHtml(COMPANY)}</td></tr>
        <tr><td style="padding:26px;color:#1f2937;font-size:15px;line-height:1.6;">
          <p style="margin:0 0 10px;font-weight:700;font-size:16px;">✅ Email is working.</p>
          <p style="margin:0;">This is a test message from your ${escapeHtml(COMPANY)} app to confirm Resend delivery is wired up correctly. Sent ${escapeHtml(when)}.</p>
        </td></tr>
      </table>
    </td></tr></table></body></html>`;
  const text = `Email is working. This is a test message from your ${COMPANY} app confirming Resend delivery. Sent ${when}.`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: SEND_FROM, to: [to], subject: `${COMPANY} — test email ✅`, html, text }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: data?.message || "Resend rejected the email.", details: data });
    return res.status(200).json({ sent: true, id: data.id || null });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to send test email" });
  }
}
