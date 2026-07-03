// api/plaid/exchange.js
// After Plaid Link succeeds it hands the app a public_token; exchange it for a permanent access_token
// and store it server-side (never returned to the client). Body: { public_token, institution? }.
import { plaidCall, saveItem, setCors, requireOwner } from "./_plaid.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const u = await requireOwner(req, res); if (!u) return;
  const { public_token, institution } = req.body || {};
  if (!public_token) return res.status(400).json({ error: "public_token required" });
  try {
    const ex = await plaidCall("/item/public_token/exchange", { public_token });
    await saveItem({ access_token: ex.access_token, item_id: ex.item_id, institution: institution || null });
    return res.status(200).json({ ok: true, institution: institution || null });
  } catch (e) {
    // A failed token-store write means the plaid_tokens table is missing/misconfigured (see
    // CLAUDE.md run-once SQL) — say so, or the owner just sees "couldn't connect" forever.
    if (/Token store write failed/i.test(e.message || "")) {
      return res.status(500).json({ error: "Connected at Plaid, but the token couldn't be saved — create the plaid_tokens table in Supabase (see CLAUDE.md), then reconnect." });
    }
    return res.status(e.missingEnv ? 501 : 502).json({ error: e.message || "Couldn't finish connecting", missingEnv: !!e.missingEnv });
  }
}
