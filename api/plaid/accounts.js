// api/plaid/accounts.js
// Lists the accounts exposed by the connected Plaid item so the app can let the owner choose WHICH
// accounts feed the Budget (one bank login can include business + personal accounts). Owner-only.
//   GET → { ok, accounts: [{ id, name, official, mask, type, subtype, available, current }], institution }
import { plaidCall, getItem, setCors, requireOwner } from "./_plaid.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const u = await requireOwner(req, res); if (!u) return;

  const item = await getItem();
  if (!item || !item.access_token) return res.status(400).json({ error: "No bank connected", connect: true });
  try {
    const d = await plaidCall("/accounts/get", { access_token: item.access_token });
    const accounts = (d.accounts || []).map((a) => ({
      id: a.account_id,
      name: a.name || "",
      official: a.official_name || "",
      mask: a.mask || "",
      type: a.type || "",
      subtype: a.subtype || "",
      available: a.balances ? a.balances.available : null,
      current: a.balances ? a.balances.current : null,
    }));
    return res.status(200).json({ ok: true, accounts, institution: item.institution || null });
  } catch (e) {
    const code = e.plaid && e.plaid.error_code;
    if (code === "PRODUCT_NOT_READY") return res.status(202).json({ error: "Your bank data is still syncing — try again in a minute.", notReady: true });
    return res.status(e.missingEnv ? 501 : 502).json({ error: e.message || "Couldn't load accounts", missingEnv: !!e.missingEnv });
  }
}
