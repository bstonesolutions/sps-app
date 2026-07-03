// api/plaid/create-link-token.js
// Creates a short-lived Plaid Link token so the app can open Plaid Link (the owner picks their bank +
// logs in through Plaid's secure UI). GET ?check → { configured, env }.
import { plaidCall, setCors, PLAID_ENV, plaidConfigured, requireOwner } from "./_plaid.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({ ok: true, configured: plaidConfigured(), env: PLAID_ENV });
  }
  const u = await requireOwner(req, res); if (!u) return;
  try {
    const data = await plaidCall("/link/token/create", {
      user: { client_user_id: String(u.id || "owner") },
      client_name: "Stone Property Solutions",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });
    return res.status(200).json({ ok: true, link_token: data.link_token, expiration: data.expiration });
  } catch (e) {
    return res.status(e.missingEnv ? 501 : 502).json({ error: e.message || "Couldn't start bank connect", missingEnv: !!e.missingEnv });
  }
}
