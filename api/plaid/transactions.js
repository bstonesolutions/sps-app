// api/plaid/transactions.js
// Real bank transactions for the Budget, pulled on demand (nothing cached at rest beyond the token).
// ?period=month|lastmonth|ytd. Returns the raw list + income/expense rolled up by Plaid category.
// Plaid sign convention: amount > 0 = money OUT (expense), < 0 = money IN (income) — we flip it so a
// positive amount means income, matching the Budget's mental model.
import { plaidCall, getItem, setCors, requireOwner } from "./_plaid.js";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function dateRange(period) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  if (period === "lastmonth") return { start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 0)) };
  if (period === "ytd") return { start: `${y}-01-01`, end: iso(now) };
  return { start: `${y}-${pad(m + 1)}-01`, end: iso(now) };
}
const titleCase = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const catLabel = (t) => {
  const p = t.personal_finance_category && t.personal_finance_category.primary;
  if (p) return titleCase(p);
  return (t.category && t.category[0]) || "Uncategorized";
};

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const u = await requireOwner(req, res); if (!u) return;

  const item = await getItem();
  if (!item || !item.access_token) return res.status(400).json({ error: "No bank connected", connect: true });

  const period = ["month", "lastmonth", "ytd"].includes(req.query && req.query.period) ? req.query.period : "month";
  const { start, end } = dateRange(period);
  try {
    let all = [], offset = 0, total = Infinity;
    while (offset < total && offset < 2000) {
      const d = await plaidCall("/transactions/get", { access_token: item.access_token, start_date: start, end_date: end, options: { count: 500, offset } });
      total = d.total_transactions != null ? d.total_transactions : (d.transactions || []).length;
      const batch = d.transactions || [];
      all = all.concat(batch);
      offset += batch.length;
      if (!batch.length) break;
    }
    const txns = all.map((t) => ({ date: t.date, name: t.merchant_name || t.name || "", amount: -(t.amount || 0), category: catLabel(t), pending: !!t.pending }));
    const income = {}, expense = {};
    txns.forEach((t) => { if (t.amount >= 0) income[t.category] = (income[t.category] || 0) + t.amount; else expense[t.category] = (expense[t.category] || 0) + (-t.amount); });
    const toArr = (o) => Object.entries(o).map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
    const totalIncome = txns.filter((t) => t.amount >= 0).reduce((s, t) => s + t.amount, 0);
    const totalExpense = txns.filter((t) => t.amount < 0).reduce((s, t) => s + (-t.amount), 0);
    return res.status(200).json({ ok: true, period, start, end, count: txns.length, transactions: txns.slice(0, 250), income: toArr(income), expense: toArr(expense), totalIncome, totalExpense, net: totalIncome - totalExpense });
  } catch (e) {
    // Plaid needs a moment to pull history right after linking — surface that clearly.
    const code = e.plaid && e.plaid.error_code;
    if (code === "PRODUCT_NOT_READY") return res.status(202).json({ error: "Your bank data is still syncing — try again in a minute.", notReady: true });
    return res.status(e.missingEnv ? 501 : 502).json({ error: e.message || "Couldn't fetch transactions", missingEnv: !!e.missingEnv });
  }
}
