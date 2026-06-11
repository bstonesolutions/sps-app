// api/quickbooks/refresh.js
// Exchanges a QuickBooks refresh token for a fresh access token.
// QB access tokens expire after ~1 hour; refresh tokens last ~100 days.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ error: "Missing refresh_token" });

  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error: "Server missing QuickBooks credentials" });

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type":  "application/x-www-form-urlencoded",
        "Accept":        "application/json",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }).toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      // Refresh token itself is invalid/expired — caller must do a full reconnect
      return res.status(401).json({ error: "Refresh failed", details: err, reconnect: true });
    }

    const tokens = await tokenRes.json();
    return res.status(200).json({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || refresh_token, // QB rotates refresh tokens
      expires_in:    tokens.expires_in,
      success: true,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
