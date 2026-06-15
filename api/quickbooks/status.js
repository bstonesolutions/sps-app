// api/quickbooks/status.js
// Tells the app whether QuickBooks is connected (tokens exist server-side). The app
// polls this right after opening the OAuth browser, and checks it on load to show
// the connected state. No tokens are ever returned to the client.
import { getTokens, setCors } from "./qb-store.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const t = await getTokens();
    return res.status(200).json({ connected: !!(t && t.access_token && t.realm_id), realmId: t?.realm_id || null });
  } catch (err) {
    return res.status(200).json({ connected: false, error: err.message });
  }
}
