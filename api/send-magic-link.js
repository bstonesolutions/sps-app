// api/send-magic-link.js
// Sends a FULLY BRANDED client portal sign-in (magic link) email via Resend,
// triggered from the login screen's "Client? Sign in with email link" flow.
//
// Flow: client enters email -> this endpoint mints a real Supabase magic link
// with the admin generate_link API (type "magiclink", which only works for an
// EXISTING user — equivalent to shouldCreateUser:false, so it never creates a
// new account) -> drops that link into the branded SPS template -> delivers it
// through Resend from the verified domain. The link itself always comes from
// Supabase; only the email delivery switches to Resend.
//
// Required env (set in Vercel, never hardcoded):
//   RESEND_API_KEY              - Resend API key
//   SUPABASE_SERVICE_ROLE_KEY   - Supabase service-role key (admin API)
// Optional env:
//   SUPABASE_URL     - defaults to the known project URL
//   RESEND_FROM      - defaults to the verified-domain sender
//   PUBLIC_APP_URL   - app origin used for the logo + default redirect

const APP_URL = process.env.PUBLIC_APP_URL || "https://spsway.app";
const LOGO_URL = `${APP_URL}/icon-192.png`;

const COMPANY = "Stone Property Solutions";
const TAGLINE = "The SPS Way";
const FOOTER = "Stone Property Solutions LLC · stonepropertysolutions.com · 149 Suplee Road · 4847574797";
const CRIMSON = "#B81D24";

const escapeHtml = (s) => String(s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Branded HTML email: crimson header bar (logo + company + tagline), greeting,
// body, large crimson CTA button, footer, and a raw-URL fallback.
function buildHtml({ link, first }) {
  const greeting = first ? `Hi ${escapeHtml(first)},` : "Hi there,";
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your secure ${COMPANY} client portal sign-in link.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <!-- Crimson header bar -->
          <tr>
            <td style="background:${CRIMSON};padding:26px 28px;text-align:center;">
              <img src="${LOGO_URL}" alt="${escapeHtml(COMPANY)}" width="56" height="56" style="display:inline-block;width:56px;height:56px;border-radius:14px;object-fit:cover;margin-bottom:12px;" />
              <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-0.02em;line-height:1.2;">${escapeHtml(COMPANY)}</div>
              <div style="color:rgba(255,255,255,0.82);font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin-top:4px;">${escapeHtml(TAGLINE)}</div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:30px 28px 8px;color:#1f2937;font-size:15px;line-height:1.6;">
              <p style="margin:0 0 14px;font-weight:700;font-size:16px;">${greeting}</p>
              <p style="margin:0 0 8px;">Tap the button below to sign in to your ${COMPANY} client portal. This link expires in 1 hour and can only be used once.</p>
            </td>
          </tr>
          <!-- CTA button -->
          <tr>
            <td align="center" style="padding:18px 28px 28px;">
              <a href="${link}" style="display:inline-block;background:${CRIMSON};color:#ffffff;text-decoration:none;font-weight:800;font-size:16px;padding:16px 34px;border-radius:14px;letter-spacing:-0.01em;">Sign In to My Portal</a>
              <div style="margin-top:18px;font-size:12px;color:#9ca3af;line-height:1.5;word-break:break-all;">If the button doesn't work, copy and paste this link into your browser:<br>${escapeHtml(link)}</div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#fafafa;border-top:1px solid #eeeeee;padding:18px 28px;text-align:center;color:#9ca3af;font-size:11px;line-height:1.6;">
              ${escapeHtml(FOOTER)}
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function buildText({ link, first }) {
  const greeting = first ? `Hi ${first},` : "Hi there,";
  return `${greeting}

Tap the link below to sign in to your ${COMPANY} client portal. This link expires in 1 hour and can only be used once.

${link}

${FOOTER}`;
}

// CORS so the native app (capacitor://localhost) can call this cross-origin via the
// absolute PROD_URL; the web build calls it same-origin.
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

import { resolveFrom, VERIFIED_DOMAIN } from "./_sender.js";

// Best-effort abuse control for the public sign-in door. Serverless instances do not share memory,
// so Supabase/Resend provider limits remain the final backstop, but this blocks rapid repeats on a
// warm instance without revealing whether an address belongs to an account.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const recentAttempts = new Map();
function withinLimit(key, limit) {
  const now = Date.now();
  const prior = (recentAttempts.get(key) || []).filter((at) => now - at < RATE_WINDOW_MS);
  if (prior.length >= limit) { recentAttempts.set(key, prior); return false; }
  prior.push(now); recentAttempts.set(key, prior);
  if (recentAttempts.size > 500) {
    for (const [k, times] of recentAttempts) if (!times.some((at) => now - at < RATE_WINDOW_MS)) recentAttempts.delete(k);
  }
  return true;
}

// LOW#6 — open-redirect allowlist. Only permit redirecting to the app's own
// origin or the native deep-link scheme; anything else falls back to APP_URL.
const ALLOWED_REDIRECTS = [APP_URL, "spsway://login"];
function safeRedirect(value) {
  return ALLOWED_REDIRECTS.includes(value) ? value : APP_URL;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  // Health check — GET reports whether keys are detected, without exposing them.
  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({
      ok: true,
      endpoint: "send-magic-link",
      configured: {
        resend: !!process.env.RESEND_API_KEY,
        supabaseServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      from: process.env.RESEND_FROM || `${COMPANY} <noreply@stonepropertysolutions.com>`,
      verifiedDomain: VERIFIED_DOMAIN,
      appUrl: APP_URL,
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, first, redirectTo } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail.length > 254 || !/.+@.+\..+/.test(normalizedEmail)) return res.status(400).json({ error: "A valid email is required" });
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || String(req.socket && req.socket.remoteAddress || "unknown");
  if (!withinLimit(`ip:${ip}`, 8) || !withinLimit(`email:${normalizedEmail}`, 3)) {
    // Success-shaped on purpose: the login screen should not fall back to a second provider call,
    // and an attacker learns nothing about whether the address exists.
    return res.status(200).json({ sent: true });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  // This endpoint is public by necessity, so callers cannot choose a verified-domain sender.
  const FROM         = resolveFrom({}, process.env.RESEND_FROM || `${COMPANY} <noreply@stonepropertysolutions.com>`);

  // Not configured yet — signal the caller so it can fall back to Supabase email.
  if (!SERVICE_KEY || !RESEND_KEY) {
    return res.status(501).json({ error: "Email delivery is not configured on the server.", missingEnv: true });
  }

  const adminHeaders = {
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    // Mint a real sign-in link. type "magiclink" only succeeds for an EXISTING
    // user — we deliberately do NOT create the user (shouldCreateUser:false), so
    // the link only works for existing clients.
    const genRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ type: "magiclink", email: normalizedEmail, redirect_to: safeRedirect(redirectTo) }),
    });
    const genData = await genRes.json().catch(() => ({}));

    if (!genRes.ok) {
      // Unknown email / no account: respond success-shaped WITHOUT sending, so we
      // never reveal whether an address is registered and never email a non-client.
      const msg = String(genData?.msg || genData?.error_description || genData?.error || "").toLowerCase();
      if (genRes.status === 404 || genRes.status === 422 || msg.includes("not found") || msg.includes("no user")) {
        return res.status(200).json({ sent: true });
      }
      return res.status(500).json({ error: "Could not generate the sign-in link." });
    }

    const link = genData.action_link || genData?.properties?.action_link;
    if (!link) return res.status(500).json({ error: "No sign-in link returned by Supabase." });

    const html = buildHtml({ link, first });
    const text = buildText({ link, first });

    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [normalizedEmail],
        subject: `Your ${COMPANY} client portal sign-in link`,
        html,
        text,
      }),
    });
    const sendData = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      return res.status(502).json({ error: "Resend rejected the email.", details: sendData });
    }

    return res.status(200).json({ sent: true, id: sendData.id || null });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to send email" });
  }
}
