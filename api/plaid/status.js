// api/plaid/status.js
// Cheap, side-effect-free "is a bank connected?" check (the app polls it like QB status).
import { getItem, setCors, plaidConfigured, PLAID_ENV } from "./_plaid.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const item = await getItem();
    return res.status(200).json({ ok: true, connected: !!(item && item.access_token), institution: (item && item.institution) || null, configured: plaidConfigured(), env: PLAID_ENV });
  } catch (e) {
    return res.status(200).json({ ok: true, connected: false, configured: plaidConfigured(), error: e.message });
  }
}
