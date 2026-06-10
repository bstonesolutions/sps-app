// api/quickbooks/auth.js
// Starts the QuickBooks OAuth 2.0 flow
export default function handler(req, res) {
  const clientId     = process.env.QB_CLIENT_ID;
  const redirectUri  = process.env.QB_REDIRECT_URI;
  const scope        = 'com.intuit.quickbooks.accounting';
  const state        = Math.random().toString(36).substring(2);

  const authUrl = new URL('https://appcenter.intuit.com/connect/oauth2');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         scope);
  authUrl.searchParams.set('state',         state);

  res.setHeader('Set-Cookie', `qb_state=${state}; Path=/; HttpOnly; SameSite=Lax`);
  res.redirect(authUrl.toString());
}
