// api/quickbooks/callback.js
// Intuit redirects here after the user authorizes. We exchange the code for tokens
// SERVER-SIDE and store them in the qb_tokens table — tokens never travel in a URL
// or reach the client. Then we show a simple "connected, return to the app" page;
// the app polls /api/quickbooks/status to detect the connection.
import { saveTokens, getTokens } from "./qb-store.js";
import crypto from "crypto";

// Same key + format as auth.js makeState(). The state is base64url("<nonce>.<ts>.<hmac>"),
// the HMAC signed over "<nonce>.<ts>". Verifying the signature (no cookie, no server store)
// is what lets reconnect survive in-app browsers that drop the qb_state cookie.
// No committed fallback (see auth.js): with no secret we fail closed so a public constant can't
// be used to forge a valid state — CSRF then relies on the cookie check below.
const STATE_SECRET = process.env.QB_STATE_SECRET || process.env.QB_CLIENT_SECRET || "";

function verifyState(state) {
  if (!state || !STATE_SECRET) return false;
  let decoded;
  try { decoded = Buffer.from(String(state), "base64url").toString("utf8"); } catch { return false; }
  const parts = decoded.split(".");
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  const expect = crypto.createHmac("sha256", STATE_SECRET).update(`${nonce}.${ts}`).digest("hex");
  let ok = false;
  try { ok = sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch { ok = false; }
  if (!ok) return false;
  const age = Date.now() - Number(ts);
  return age >= -60000 && age < 10 * 60 * 1000; // within the last 10 min (60s skew tolerance)
}

function page(title, message, ok) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;background:#F5F5F7;color:#1d1d1f;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="max-width:360px;text-align:center;padding:28px 24px;background:#fff;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,0.08)">
<div style="font-size:40px;margin-bottom:10px">${ok ? "✅" : "⚠️"}</div>
<div style="font-size:18px;font-weight:800;margin-bottom:8px">${title}</div>
<div style="font-size:14px;color:#6b7280;line-height:1.5">${message}</div>
</div></body></html>`;
}

export default async function handler(req, res) {
  const { code, realmId, error, state } = req.query;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (error)             return res.status(200).send(page("QuickBooks not connected", "Authorization was cancelled or denied. You can close this window and try again.", false));
  if (!code || !realmId) return res.status(200).send(page("QuickBooks not connected", "Missing authorization code. Please close this window and try again.", false));

  // CSRF, BEFORE we exchange the code or bind any tokens: accept the state Intuit echoes back
  // if it carries a valid signature (cookie-free — survives in-app browsers that drop cookies),
  // OR matches the qb_state cookie (plain-browser fallback). Then clear the cookie.
  const cookieState = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith("qb_state="))?.slice("qb_state=".length);
  if (!verifyState(state) && !(state && cookieState && state === cookieState)) {
    return res.status(200).send(page("QuickBooks not connected", "Security check failed. Please close this window and try connecting again.", false));
  }
  res.setHeader("Set-Cookie", "qb_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");

  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const redirectUri  = process.env.QB_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(200).send(page("Server not configured", "QuickBooks credentials are missing on the server.", false));
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type":  "application/x-www-form-urlencoded",
        "Accept":        "application/json",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
    });

    const responseText = await tokenRes.text();
    if (!tokenRes.ok) {
      console.error("QB token exchange failed:", tokenRes.status, responseText);
      return res.status(200).send(page("QuickBooks not connected", "We couldn't complete the connection with Intuit. Please close this window and try again.", false));
    }

    const tokens = JSON.parse(responseText);
    await saveTokens({
      realm_id:      realmId,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in:    tokens.expires_in,
    });

    // Read-after-write: confirm the token actually PERSISTED and is readable (with a realm_id) before
    // we tell the user "connected". Without this, a misconfigured token store — a missing/wrong
    // qb_tokens table, a null realm_id, or a Supabase URL/key mismatch — can make saveTokens NOT throw
    // yet leave nothing for /status to read, which is exactly the "connects in the browser but reloads
    // as not connected / Load failed" bug. Surfacing it here stops the false "connected" page.
    const saved = await getTokens().catch(() => null);
    if (!saved || !saved.access_token || !saved.realm_id) {
      console.error("QB save verification failed — token not readable after save:", { hasRow: !!saved, realm: saved && saved.realm_id, hasAccess: !!(saved && saved.access_token) });
      return res.status(200).send(page("QuickBooks not connected", "We reached QuickBooks, but the app couldn't save the connection. This is a server setup issue — the qb_tokens table is likely missing or misconfigured. Tell your developer: “QB token save verification failed”, then reconnect once it's fixed.", false));
    }

    return res.status(200).send(page("QuickBooks connected", "You're all set. Close this window and return to the SPS app — it will show as connected.", true));
  } catch (err) {
    console.error("QB callback error:", err.message);
    return res.status(200).send(page("QuickBooks not connected", "Something went wrong finishing the connection. Please close this window and try again.", false));
  }
}
