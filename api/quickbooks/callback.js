// api/quickbooks/callback.js
// Intuit redirects here after the user authorizes. We exchange the code for tokens
// SERVER-SIDE and store them in the qb_tokens table — tokens never travel in a URL
// or reach the client. Then we show a simple "connected, return to the app" page;
// the app polls /api/quickbooks/status to detect the connection.
import { saveTokens } from "./qb-store.js";

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
  const { code, realmId, error } = req.query;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (error)             return res.status(200).send(page("QuickBooks not connected", "Authorization was cancelled or denied. You can close this window and try again.", false));
  if (!code || !realmId) return res.status(200).send(page("QuickBooks not connected", "Missing authorization code. Please close this window and try again.", false));

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

    return res.status(200).send(page("QuickBooks connected", "You're all set. Close this window and return to the SPS app — it will show as connected.", true));
  } catch (err) {
    console.error("QB callback error:", err.message);
    return res.status(200).send(page("QuickBooks not connected", "Something went wrong finishing the connection. Please close this window and try again.", false));
  }
}
