// api/quickbooks/status.js
// Tells the app whether QuickBooks is connected. The app polls this every few seconds (and
// during the connect window), so it must be CHEAP and side-effect-free: we read the stored
// token row and report "connected" when it exists and is still usable — either not hard-expired,
// or holding a refresh token to renew on the next real API call. We deliberately do NOT call
// getValidAccessToken() here: that refreshes (rotating QB's refresh token), which on a frequent
// poll would race with concurrent polls + real syncs and flicker the connection. The actual
// write endpoints (sync) refresh on demand and surface a "reconnect" if the refresh token is dead.
import { getTokens, setCors } from "./qb-store.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const t = await getTokens();
    const exists = !!(t && t.access_token && t.realm_id);
    const expMs = exists && t.expires_at ? new Date(t.expires_at).getTime() : 0;
    const usable = exists && (!!t.refresh_token || expMs > Date.now());
    return res.status(200).json({ connected: usable, realmId: t?.realm_id || null });
  } catch (err) {
    return res.status(200).json({ connected: false, error: err.message });
  }
}
