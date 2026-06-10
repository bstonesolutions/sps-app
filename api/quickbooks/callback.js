// api/quickbooks/callback.js
export default async function handler(req, res) {
  const { code, realmId, error } = req.query;

  if (error) {
    return res.redirect('/?qb=error&reason=' + encodeURIComponent(error));
  }
  if (!code || !realmId) {
    return res.status(400).json({ error: 'Missing code or realmId' });
  }

  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const redirectUri  = process.env.QB_REDIRECT_URI;

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

  // Pass tokens back to the app via URL params so they can be stored in localStorage
  const params = new URLSearchParams({
    qb:            'connected',
    realmId,
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in:    tokens.expires_in,
  });

  res.redirect('/?' + params.toString());
}
