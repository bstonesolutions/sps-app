// api/quickbooks/auth.js
// Starts the QuickBooks OAuth 2.0 flow.
//
// The CSRF "state" is a self-contained, HMAC-signed token (random nonce + timestamp) rather
// than a value we have to remember in a cookie. In-app browsers / popups frequently drop the
// cookie across the Intuit round-trip, which made the callback's old cookie check fail with
// "Security check failed" and blocked reconnecting. A signed state needs no cookie: the
// callback re-verifies the signature with the same server secret, so it survives any browser
// context. We still set the cookie too, as a harmless fallback for plain-browser flows.
import crypto from "crypto";

// HMAC key for signing the state: a dedicated secret if provided, else the QB client secret
// (always present server-side for the token exchange, and never leaves the server). Used only
// to sign/verify state — it is never exposed to the client.
// No committed fallback: if neither secret is set we must NOT sign with a public constant
// (that would make the state forgeable). With no secret, verifyState() in callback.js fails
// closed and the flow falls back to the cookie check. QB_CLIENT_SECRET is required for the
// token exchange anyway, so in any working deploy this is non-empty.
const STATE_SECRET = process.env.QB_STATE_SECRET || process.env.QB_CLIENT_SECRET || "";

function makeState() {
  const raw = `${crypto.randomBytes(12).toString("hex")}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", STATE_SECRET).update(raw).digest("hex");
  return Buffer.from(`${raw}.${sig}`).toString("base64url");
}

export default function handler(req, res) {
  const clientId     = process.env.QB_CLIENT_ID;
  const redirectUri  = process.env.QB_REDIRECT_URI;
  const scope        = 'com.intuit.quickbooks.accounting';
  const state        = makeState(); // signed CSRF token, echoed back by Intuit + verified in callback

  const authUrl = new URL('https://appcenter.intuit.com/connect/oauth2');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         scope);
  authUrl.searchParams.set('state',         state);

  // Belt-and-suspenders: also drop the state in a cookie for plain browsers. The callback
  // accepts EITHER a valid signature (cookie-free) OR a matching cookie.
  res.setHeader('Set-Cookie', `qb_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.redirect(authUrl.toString());
}
