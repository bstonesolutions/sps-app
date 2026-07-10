// api/_bank.js — shared server-side bank reads for report emails (task #67: the digest shows
// the SAME numbers as the Budget hub). Deliberately a twin of transfer-nudge's fetchBank
// rather than a refactor — the shipped nudge stays untouched. Semantics mirror App.jsx
// bankMonthSummary: the owner's categorization (txMarks/txRules) wins over the sign default,
// "ignore" is excluded everywhere, income/expense report clamped but profit uses the raw sums,
// and markOf keeps the pending-twin fallback (the server can't run the app's pending→posted
// mark migration). Ships dark: fetchBankTxns returns null unless Plaid is configured AND a
// bank is connected AND reachable — callers just skip their bank section.

import { getItem, plaidCall, enabledAccountSet, filterByAccounts } from "./plaid/_plaid.js";

const pad2 = (n) => String(n).padStart(2, "0");
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

export async function fetchBankTxns() {
  const item = await getItem();
  if (!item || !item.access_token) return null;
  const today = new Date();
  const start = new Date(today); start.setDate(start.getDate() - 100); // covers this month + last
  const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  let all = [], offset = 0, total = Infinity;
  try {
    while (offset < total && offset < 2000) {
      const d = await plaidCall("/transactions/get", { access_token: item.access_token, start_date: iso(start), end_date: iso(today), options: { count: 500, offset } });
      total = d.total_transactions != null ? d.total_transactions : (d.transactions || []).length;
      const batch = d.transactions || [];
      all = all.concat(batch); offset += batch.length;
      if (!batch.length) break;
    }
  } catch { return null; } // bank unreachable → caller skips its bank section
  // Honor the owner's Bank Sync account picker (business-only, etc.) — same filter the Budget uses.
  const kept = filterByAccounts(all, await enabledAccountSet());
  // Same sign flip as api/plaid/transactions.js: + = money in.
  return kept.map((t) => ({ id: t.transaction_id || "", pendingId: t.pending_transaction_id || null, date: t.date || "", name: t.merchant_name || t.name || "", amount: -(t.amount || 0) }));
}

// One calendar month (ym = "2026-07") rolled up with the owner's categorization applied.
export function bankMonthRollup(txns, budget, ym) {
  if (!txns) return null;
  const marks = (budget && budget.txMarks) || {}, rules = (budget && budget.txRules) || {};
  const markOf = (t) => marks[t.id] || (t.pendingId && marks[t.pendingId]) || rules[norm(t.name)] || null;
  let income = 0, expense = 0, savings = 0, debt = 0, count = 0;
  txns.forEach((t) => {
    if (!String(t.date).startsWith(ym)) return;
    const m = markOf(t);
    const kind = (m && m.kind) || (t.amount >= 0 ? "income" : "expense");
    if (kind === "ignore") return;
    count++;
    if (kind === "income") income += t.amount;
    else if (kind === "expense") expense += -t.amount;
    else if (kind === "savings") savings += -t.amount;
    else if (kind === "debt") debt += -t.amount;
  });
  return { ym, income: Math.max(0, income), expense: Math.max(0, expense), savings: Math.max(0, savings), debt: Math.max(0, debt), profit: income - expense, count };
}
