// api/quickbooks/callback.js
// Handles the OAuth callback, exchanges code for tokens, stores them
export default async function handler(req, res) {
  const { code, realmId, state, error } = req.query;

  if (error) {
    return res.redirect('/?qb=error&reason=' + encodeURIComponent(error));
  }
  if (!code || !realmId) {
    return res.status(400).json({ error: 'Missing code or realmId' });
  }

  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const redirectUri  = process.env.QB_REDIRECT_URI;

  // Exchange auth code for tokens
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json',
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('QB token error:', err);
    return res.redirect('/?qb=error&reason=token_exchange_failed');
  }

  const tokens = await tokenRes.json();
  // Store tokens + realmId in cookies (short-lived; in production use a DB or KV store)
  const expires = new Date(Date.now() + tokens.expires_in * 1000).toUTCString();
  const cookieOpts = `Path=/; HttpOnly; SameSite=Lax; Expires=${expires}`;
  res.setHeader('Set-Cookie', [
    `qb_access_token=${tokens.access_token}; ${cookieOpts}`,
    `qb_refresh_token=${tokens.refresh_token}; Path=/; HttpOnly; SameSite=Lax`,
    `qb_realm_id=${realmId}; ${cookieOpts}`,
  ]);

  // Redirect back to app with success flag
  res.redirect('/?qb=connected&realmId=' + realmId);
}
