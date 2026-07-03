// api/plaid/disconnect.js
// Unlink the bank: remove the item at Plaid and drop the stored token.
import { plaidCall, getItem, clearItem, setCors, requireOwner } from "./_plaid.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const u = await requireOwner(req, res); if (!u) return;
  try {
    const item = await getItem();
    if (item && item.access_token) { try { await plaidCall("/item/remove", { access_token: item.access_token }); } catch (_) { /* best-effort */ } }
    await clearItem();
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Couldn't disconnect" });
  }
}
