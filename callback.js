// api/quickbooks/callback.js
export default async function handler(req, res) {
  const { code, realmId, error } = req.query;

  if (error) {
    return res.redirect('/?qb=error&reason=' + encodeURIComponent(error));
  }
  if (!code || !realmId) {
    return res.redirect('/?qb=error&reason=missing_code_or_realm');
  }

  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const redirectUri  = process.env.QB_REDIRECT_URI;

  // Log what we have (no secrets)
  console.log('QB Callback - clientId present:', !!clientId);
  console.log('QB Callback - clientSecret present:', !!clientSecret);
  console.log('QB Callback - redirectUri:', redirectUri);
  console.log('QB Callback - code present:', !!code);
  console.log('QB Callback - realmId:', realmId);

  if (!clientId || !clientSecret || !redirectUri) {
    return res.redirect('/?qb=error&reason=missing_env_vars');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
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
      }).toString(),
    });

    const responseText = await tokenRes.text();
    console.log('QB Token response status:', tokenRes.status);
    console.log('QB Token response:', responseText);

    if (!tokenRes.ok) {
      return res.redirect('/?qb=error&reason=' + encodeURIComponent('token_failed_' + tokenRes.status));
    }

    const tokens = JSON.parse(responseText);

    const params = new URLSearchParams({
      qb:            'connected',
      realmId,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      expires_in:    tokens.expires_in || 3600,
    });

    res.redirect('/?' + params.toString());

  } catch (err) {
    console.error('QB callback error:', err.message);
    res.redirect('/?qb=error&reason=' + encodeURIComponent(err.message));
  }
}
