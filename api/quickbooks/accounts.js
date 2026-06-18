// api/quickbooks/accounts.js
// Read-only: returns the deposit-eligible accounts (bank accounts + Undeposited
// Funds) and the payment methods from the connected QuickBooks company's chart of
// accounts, so the app can offer a real "deposit to" account when recording a
// manual payment. The app NEVER moves money — this only reads names/ids.
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
import { requireUser } from "../_auth.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const _u = await requireUser(req, res);
  if (!_u) return;

  let access_token, realm_id;
  try {
    ({ access_token, realm_id } = await getValidAccessToken());
  } catch (e) {
    return res.status(401).json({ error: "Not connected to QuickBooks", reconnect: true });
  }

  const base = `${QB_API_BASE}/v3/company/${realm_id}`;
  const headers = { "Authorization": `Bearer ${access_token}`, "Accept": "application/json" };
  const query = async (q) => {
    const r = await fetch(`${base}/query?query=${encodeURIComponent(q)}&minorversion=65`, { headers });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.Fault && d.Fault.Error && d.Fault.Error[0] && d.Fault.Error[0].Message) || `QuickBooks query failed (${r.status})`);
    return d.QueryResponse || {};
  };

  try {
    const acctResp = await query("SELECT Id, Name, AccountType, AccountSubType FROM Account WHERE Active = true MAXRESULTS 1000");
    // Deposit-to accounts = bank accounts + the Undeposited Funds holding account.
    const depositAccounts = (acctResp.Account || [])
      .filter(a => a.AccountType === "Bank" || a.AccountSubType === "UndepositedFunds")
      .map(a => ({ id: a.Id, name: a.Name, type: a.AccountType, sub: a.AccountSubType }));

    let paymentMethods = [];
    try {
      const pmResp = await query("SELECT Id, Name FROM PaymentMethod MAXRESULTS 200");
      paymentMethods = (pmResp.PaymentMethod || []).map(p => ({ id: p.Id, name: p.Name }));
    } catch (_) { /* payment methods are optional */ }

    return res.status(200).json({ depositAccounts, paymentMethods });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to read accounts" });
  }
}
