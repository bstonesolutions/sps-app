// api/quickbooks/status.js
// Tells the app whether QuickBooks is connected. The app polls this every few seconds (and
// during the connect window), so it must be CHEAP and side-effect-free: we read the stored
// token row and report "connected" when it exists and is still usable — either not hard-expired,
// or holding a refresh token to renew on the next real API call. We deliberately do NOT call
// getValidAccessToken() here: that refreshes (rotating QB's refresh token), which on a frequent
// poll would race with concurrent polls + real syncs and flicker the connection. The actual
// write endpoints (sync) refresh on demand and surface a "reconnect" if the refresh token is dead.
import { getTokens, setCors, QB_API_BASE } from "./qb-store.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const t = await getTokens();
    const exists = !!(t && t.access_token && t.realm_id);
    const expMs = exists && t.expires_at ? new Date(t.expires_at).getTime() : 0;
    const usable = exists && (!!t.refresh_token || expMs > Date.now());

    // Diagnostic (?debug=1): report NON-SECRET config so we can confirm which Intuit app/keys are
    // actually deployed. The client_id is already public (it ships in the OAuth authorize URL); we
    // return only its last 8 chars to compare against the Intuit console. No secret is exposed.
    // Remove this branch once the QuickBooks connection is verified working.
    if (req.query && req.query.debug) {
      const cid = process.env.QB_CLIENT_ID || "";
      return res.status(200).json({
        connected: usable,
        realmId: t?.realm_id || null,
        clientIdTail: cid ? cid.slice(-8) : null,
        apiBase: QB_API_BASE,
        redirectUri: process.env.QB_REDIRECT_URI || null,
        hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        token: exists ? {
          hasAccess:  !!t.access_token,
          hasRefresh: !!t.refresh_token,
          expiresAt:  t.expires_at || null,
          expired:    expMs ? expMs < Date.now() : null,
        } : null,
      });
    }

    return res.status(200).json({ connected: usable, realmId: t?.realm_id || null });
  } catch (err) {
    return res.status(200).json({ connected: false, error: err.message });
  }
}
