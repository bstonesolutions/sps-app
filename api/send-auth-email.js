// api/send-auth-email.js
// Sends a branded staff-invite or client magic-link email via Resend.
// Flow: ensure the auth user exists -> mint a real sign-in link with the
// Supabase admin API (generate_link) -> drop that link into the caller's
// editable template -> deliver it through Resend from the verified domain.
//
// Required env (set in Vercel, never hardcoded):
//   RESEND_API_KEY              - Resend API key
//   SUPABASE_SERVICE_ROLE_KEY   - Supabase service-role key (admin API)
// Optional env:
//   SUPABASE_URL   - defaults to the known project URL
//   RESEND_FROM    - defaults to "Stone Property Solutions <noreply@stonepropertysolutions.com>"

const DEFAULTS = {
  staff: {
    subject: "You're invited to the {company} team app",
    body: "Hi {name},\n\nYou've been added to the {company} team app. Tap the secure link below to sign in — no password needed.\n\n{link}\n\nSee you inside,\nThe {company} Team",
  },
  client: {
    subject: "Your {company} client portal link",
    body: "Hi {first},\n\nHere's your secure link to your {company} client portal. Tap below to view your service history, invoices, and photos — no password required.\n\n{link}\n\nThank you for being a valued client,\nThe {company} Team",
  },
};

const escapeHtml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fillVars = (str, vars) => String(str || "")
  .replace(/\{company\}/g, vars.company || "")
  .replace(/\{name\}/g, vars.name || "")
  .replace(/\{first\}/g, vars.first || "");

// Turn the plain-text body into a simple branded HTML email, replacing the
// {link} token with a tappable button (and a raw URL fallback).
function buildHtml(body, link) {
  const button = `<a href="${link}" style="display:inline-block;background:#B81D24;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:12px;font-size:15px">Sign in</a>`;
  let html = escapeHtml(body);
  if (html.includes("{link}")) html = html.replace(/\{link\}/g, button);
  else html += `\n\n${button}`;
  html = html.replace(/\n/g, "<br>");
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;max-width:520px;margin:0 auto;padding:8px">${html}<div style="margin-top:18px;font-size:12px;color:#9ca3af;word-break:break-all">If the button doesn't work, copy this link:<br>${link}</div></div>`;
}

export default async function handler(req, res) {
  // Health check — GET (or ?check=1) reports whether the keys are detected,
  // WITHOUT exposing any secret values. Visit /api/send-auth-email to confirm.
  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({
      ok: true,
      endpoint: "send-auth-email",
      configured: {
        resend: !!process.env.RESEND_API_KEY,
        supabaseServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      from: process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>",
      supabaseUrl: process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co",
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, name, kind = "client", subject, body, redirectTo, company } = req.body || {};
  if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: "A valid email is required" });

  const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  const FROM         = process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>";

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
    // 1) Ensure the auth user exists (idempotent — ignore "already registered").
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ email, email_confirm: true, user_metadata: name ? { name } : undefined }),
      });
    } catch (_) { /* fall through — generate_link works for existing users */ }

    // 2) Mint a real sign-in link.
    const genRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ type: "magiclink", email, redirect_to: redirectTo || undefined }),
    });
    const genData = await genRes.json().catch(() => ({}));
    if (!genRes.ok) {
      return res.status(500).json({ error: "Could not generate the sign-in link.", details: genData });
    }
    const link = genData.action_link || genData?.properties?.action_link;
    if (!link) return res.status(500).json({ error: "No sign-in link returned by Supabase." });

    // 3) Compose the email from the caller's template (or a sensible default).
    const tpl = DEFAULTS[kind] || DEFAULTS.client;
    const vars = { company: company || "Stone Property Solutions", name: name || "", first: (name || "").split(" ")[0] };
    const finalSubject = fillVars(subject || tpl.subject, vars);
    const filledBody   = fillVars(body || tpl.body, vars);
    const text = filledBody.includes("{link}") ? filledBody.replace(/\{link\}/g, link) : `${filledBody}\n\n${link}`;
    const html = buildHtml(filledBody, link);

    // 4) Deliver via Resend.
    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [email], subject: finalSubject, html, text }),
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
