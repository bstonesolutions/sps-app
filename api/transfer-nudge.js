// api/transfer-nudge.js
// The "money plan" nudge — the app can't (and shouldn't) move money, so it does the thinking and
// texts/emails the owner an updated monthly reserve TARGET: taxes to set aside (from REAL bank profit +
// the tax config), payroll runs still to cover this month (from the payroll config + Gusto debits
// detected in the bank feed), debt minimums not yet paid (marks-aware), and planned savings-goal
// contributions. The owner executes the transfer in their bank — the app never touches funds.
//
// Modes (mirrors api/owner-digest.js):
//   GET ?check   → { configured: { quo, resend, plaid } }
//   ?preview=1   → OWNER-gated: computed plan JSON + the message text (drives the in-app card).
//   ?test=1      → OWNER-gated: sends the nudge to the owner NOW (whatever channels are configured).
//   (cron)       → hourly with CRON_SECRET: sends when due, once per useful change and at most once
//                  per destination on a scheduled day (per-channel atomic ledger).
//
// Config in sps_schedule_cfg.transferNudge = { on, freq: "weekly"|"monthly", weekday(0-6),
// monthDay(1-28), hour (ET, default 8), channel: "sms"|"email"|"both", toPhone?, toEmail? }.
// Payroll config in sps_costs.payroll = { freq: ""|"weekly"|"biweekly"|"monthly",
// anchor: "YYYY-MM-DD" (a recent payday), amount: "" (typical all-in cost per run; blank → detect) }.
// Ledger in sps_nudge_log (separate key so the cron never rewrites the app-edited cfg).

import { getItem, plaidCall, requireOwner, filterByAccounts } from "./plaid/_plaid.js";
import { mutateAppState, NO_APP_STATE_CHANGE, readAppStateVersioned } from "./_app-state.js";
import { pushOwner } from "./_push.js";
import { createHash, createHmac, randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const QUO_KEY      = process.env.QUO_API_KEY;
const QUO_FROM     = process.env.QUO_PHONE_NUMBER;
const CRON_SECRET  = process.env.CRON_SECRET;

const n = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
const money = (v) => { const x = Math.round(n(v)); return `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US")}`; };
const pad2 = (x) => String(x).padStart(2, "0");

export function providerFailureMeta(status) {
  const code = Number(status);
  if (code === 429) return { retryable: true };
  // Without a provider idempotency key, a 5xx is ambiguous: the provider may have accepted the
  // request before its response failed. Treat it as possibly delivered instead of risking a repeat.
  if (code >= 500) return { uncertain: true };
  return { retryable: false };
}

// ── app_state (service-role) ──────────────────────────────────────────────────────────────────────
const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
async function sbGet(key, fallback) {
  try {
    const row = await readAppStateVersioned(key);
    return row.exists && row.value != null ? row.value : fallback;
  } catch { return fallback; }
}

// The weekly plan must never turn a storage outage into financial advice. Unlike the best-effort
// settings reads above, these two inputs carry the numbers themselves, so preserve read status and
// let the message say that no calculation was made when either read fails.
async function sbGetPlanInput(key, fallback) {
  try {
    const row = await readAppStateVersioned(key);
    return { ok: true, value: row.exists && row.value != null ? row.value : fallback };
  } catch {
    return { ok: false, value: fallback };
  }
}

// ── ET clock (same shape as owner-digest) ─────────────────────────────────────────────────────────
function etNow() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const wk = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { mdy: `${p.month}/${p.day}/${p.year}`, hour: (+p.hour) % 24, weekday: wk[p.weekday], day: +p.day, ym: `${p.year}-${p.month}`, y: +p.year, m: +p.month };
}

// ── sends ─────────────────────────────────────────────────────────────────────────────────────────
function toE164(s) {
  const raw = String(s == null ? "" : s).trim();
  if (raw.startsWith("+")) return "+" + raw.slice(1).replace(/\D/g, "");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d ? "+" + d : "";
}
// Comms → Log entries for whatever channels actually attempted. SECURITY: sps_comms_log is
// readable by any authenticated session (staff + portal clients) until the RLS lockdown, so
// the log row carries a NEUTRAL body — never the plan itself (tax/payroll/debt amounts) —
// and "you" instead of the owner's personal phone/email.
async function logNudge(out, origin) {
  const put = (channel, ok) =>
    fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, {
      method: "POST", headers: sbHeaders(),
      body: JSON.stringify({ client_id: "", type: "Money plan", channel, body: "Money plan sent — open Budget for the numbers.", ok: !!ok, origin, recipient: "you" }),
    }).catch(() => {});
  try {
    if (out.sms) await put("sms", out.sms.ok);
    if (out.email) await put("email", out.email.ok);
  } catch { /* best-effort */ }
}

async function sendQuo(to, message) {
  // The Vercel business number is the only allowed Quo sender, matching every client text route.
  const toNum = toE164(to), fromNum = toE164(QUO_FROM);
  if (!QUO_KEY || !fromNum) return { ok: false, retryable: false, error: "texting not configured (QUO_API_KEY / QUO_PHONE_NUMBER)" };
  if (!toNum) return { ok: false, retryable: false, error: "no number found — set your Owner Alerts phone (Customize → Communications) or type one on the nudge card" };
  if (toNum === fromNum) return { ok: false, retryable: false, error: "owner phone matches the business texting number — set your personal number" };
  try {
    const r = await fetch("https://api.quo.com/v1/messages", {
      method: "POST", headers: { Authorization: QUO_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(message), from: fromNum, to: [toNum] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, ...providerFailureMeta(r.status), error: data?.message || data?.error || `Quo ${r.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, uncertain: true, error: e.message || "network" }; }
}
async function sendEmail(to, subject, textBody, branding) {
  if (!RESEND_KEY) return { ok: false, retryable: false, error: "email not configured (RESEND_API_KEY)" };
  if (!to || !/.+@.+\..+/.test(to)) return { ok: false, retryable: false, error: "no owner email — set one on the nudge or in settings" };
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = textBody.split("\n").map((l) => `<div style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#26211C;">${esc(l)}</div>`).join("");
  const html = `<div style="max-width:520px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
    <div style="font-size:17px;font-weight:800;color:#26211C;margin-bottom:14px;">${esc(branding.companyName || "Stone Property Solutions")} — money plan</div>
    <div style="background:#faf9f7;border:1px solid #e8e5e0;border-radius:14px;padding:18px;">${rows}</div>
    <div style="font-size:11px;color:#8a857e;margin-top:12px;">This is a reserve target, not a new transfer instruction. The app never moves funds. General guidance, not financial advice.</div>
  </div>`;
  const from = process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text: textBody }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, ...providerFailureMeta(r.status), error: d?.message || `Resend ${r.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, uncertain: true, error: e.message || "network" }; }
}

// ── bank: this month's marks-aware summary + payroll detection (server twin of the app's engine) ──
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const PAYROLL_RE = /gusto|payroll|adp\b|paychex|paycor|onpay|heartland payroll|intuit.*payroll|quickbooks payroll/i;
async function fetchBank(budget) {
  const item = await getItem();
  if (!item || !item.access_token) return { status: "not_connected", income: 0, expense: 0, profit: 0, currentCount: 0, lastDate: null, payrollDetected: null };
  const today = new Date();
  const start = new Date(today); start.setDate(start.getDate() - 100); // covers payroll cadence + this month
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
  } catch { return { status: "unavailable", income: 0, expense: 0, profit: 0, currentCount: 0, lastDate: null, payrollDetected: null }; }
  // Honor the owner's Bank Sync account picker (business-only, etc.). The normal Budget helper is
  // intentionally best-effort, but financial advice must fail to a labeled planned fallback rather
  // than silently including every linked (possibly personal) account when this setting cannot load.
  const selectionRead = await sbGetPlanInput("sps_plaid_sel", {});
  if (!selectionRead.ok) return { status: "unavailable", income: 0, expense: 0, profit: 0, currentCount: 0, lastDate: null, payrollDetected: null };
  if (selectionRead.value && Object.prototype.hasOwnProperty.call(selectionRead.value, "enabled") && !Array.isArray(selectionRead.value.enabled)) {
    return { status: "unavailable", income: 0, expense: 0, profit: 0, currentCount: 0, lastDate: null, payrollDetected: null };
  }
  const enabledIds = Array.isArray(selectionRead.value?.enabled) ? selectionRead.value.enabled.map(String).filter(Boolean) : [];
  const kept = filterByAccounts(all, enabledIds.length ? new Set(enabledIds) : null);
  const txns = kept.map((t) => ({ id: t.transaction_id || "", pendingId: t.pending_transaction_id || null, date: t.date || "", name: t.merchant_name || t.name || "", amount: -(t.amount || 0), category: (t.personal_finance_category && t.personal_finance_category.primary) || "" }));

  const marks = (budget && budget.txMarks) || {}, rules = (budget && budget.txRules) || {};
  // Same pre-migration posture as the app: a mark keyed on the pending twin still counts.
  const markOf = (t) => marks[t.id] || (t.pendingId && marks[t.pendingId]) || rules[norm(t.name)] || null;
  const effKind = (t) => { const m = markOf(t); return (m && m.kind) || (t.amount >= 0 ? "income" : "expense"); };

  const et = etNow();
  const ym = `${et.y}-${pad2(et.m)}`;
  let income = 0, expense = 0, currentCount = 0;
  txns.forEach((t) => {
    if (!t.date.startsWith(ym)) return;
    const k = effKind(t);
    if (k === "ignore") return;
    if (k === "income") { currentCount += 1; income += t.amount; }
    else if (k === "expense") { currentCount += 1; expense += -t.amount; }
  });

  // Payroll runs in the feed: Gusto/processor debits (skip anything the owner re-marked as
  // not-expense). Processors often debit 2-3 times per run (wages, taxes, fees) — group by DATE
  // first, so a run's amount is the day's total and cadence is between distinct paydays.
  const hits = txns.filter((t) => t.amount < 0 && (PAYROLL_RE.test(t.name) || PAYROLL_RE.test(t.category)) && effKind(t) !== "ignore");
  const byDate = {};
  hits.forEach((t) => { byDate[t.date] = (byDate[t.date] || 0) + Math.abs(t.amount); });
  const runDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a)).slice(0, 6);
  let payrollDetected = null;
  if (runDates.length >= 2) {
    const amts = runDates.map((d) => byDate[d]).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 0; i < runDates.length - 1; i++) gaps.push(Math.round((Date.parse(runDates[i]) - Date.parse(runDates[i + 1])) / 86400000));
    gaps.sort((a, b) => a - b);
    payrollDetected = { amount: amts[Math.floor(amts.length / 2)], everyDays: gaps[Math.floor(gaps.length / 2)] || 14, lastDate: runDates[0], runs: runDates.length };
  }
  const lastDate = txns.reduce((latest, t) => String(t.date || "") > latest ? String(t.date || "") : latest, "") || null;
  return {
    status: currentCount > 0 ? "current" : "no_current_activity",
    income: Math.max(0, income), expense: Math.max(0, expense), profit: income - expense,
    currentCount, lastDate, payrollDetected,
  };
}

// ── taxes (twin of the app's estimateTaxes; same fields in sps_costs.tax) ─────────────────────────
function monthlyTaxSetAside(profitMo, tax) {
  // Merge the same defaults the app always applies (DEFAULT_COSTS.tax) — an sps_costs row that
  // predates the tax block must yield the SAME set-aside the Budget card shows, not $0.
  const t = { enabled: true, paStateRate: "3.07", localEitRate: "1.0", selfEmploymentRate: "15.3", federalRate: "12", sCorpElected: false, reasonableSalary: "", ...(tax || {}) };
  if (!t.enabled) return 0;
  const netProfit = Math.max(0, profitMo) * 12;
  if (netProfit <= 0) return 0;
  const seBase = t.sCorpElected ? n(t.reasonableSalary) : netProfit;
  const se = seBase * (n(t.selfEmploymentRate) / 100);
  const federal = Math.max(0, netProfit - se / 2) * (n(t.federalRate) / 100);
  const paState = netProfit * (n(t.paStateRate) / 100);
  const local = netProfit * (n(t.localEitRate) / 100);
  return (se + federal + paState + local) / 12;
}

// ── payroll schedule: paydays remaining in the current ET month + the next one ────────────────────
function payrollPlan(pcfg, detected, et) {
  const freq = (pcfg && pcfg.freq) || "";
  // Payroll Off in the config = left out of the plan entirely (even when the bank detects runs) —
  // this must mirror the client card exactly or the nudge disagrees with the app.
  if (!freq) return { remaining: 0, runsLeft: 0, next: null, amount: 0 };
  const amount = n(pcfg && pcfg.amount) || (detected ? detected.amount : 0);
  if (!amount) return { remaining: 0, runsLeft: 0, next: null, amount: 0 };
  const stepDays = freq === "weekly" ? 7 : freq === "biweekly" ? 14 : 0;
  const todayUTC = Date.UTC(et.y, et.m - 1, et.day);
  const monthEndUTC = Date.UTC(et.y, et.m, 0);
  const dates = [];
  const anchor = pcfg && /^\d{4}-\d{2}-\d{2}$/.test(pcfg.anchor || "") ? pcfg.anchor : (detected ? detected.lastDate : "");
  if ((freq === "weekly" || freq === "biweekly") && anchor) {
    const step = stepDays * 86400000;
    let t = Date.parse(anchor + "T00:00:00Z");
    while (t - step > todayUTC) t -= step;                        // future-dated anchor → snap back onto the grid
    while (t <= todayUTC) t += step;                              // first payday AFTER today
    for (; dates.length < 4; t += step) dates.push(t);
  } else if (freq === "monthly" && anchor) {
    const ad = +anchor.slice(8, 10);
    for (let k = 0; dates.length < 2 && k < 3; k++) {
      const y = et.y, m0 = et.m - 1 + k;
      const last = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
      const t = Date.UTC(y, m0, Math.min(ad, last));
      if (t > todayUTC) dates.push(t);
    }
  } else if (detected && detected.everyDays > 0) {
    let t = Date.parse(detected.lastDate + "T00:00:00Z") + detected.everyDays * 86400000;
    while (t <= todayUTC) t += detected.everyDays * 86400000;
    for (; dates.length < 4; t += detected.everyDays * 86400000) dates.push(t);
  }
  const runsLeft = dates.filter((t) => t <= monthEndUTC).length;
  const next = dates.length ? new Date(dates[0]) : null;
  return { remaining: runsLeft * amount, runsLeft, amount, next: next ? `${next.getUTCMonth() + 1}/${next.getUTCDate()}` : null };
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────
export function chooseProfitBasis(bank, plannedProfit) {
  const actual = !!bank && bank.status === "current" && n(bank.currentCount) > 0;
  return { profit: Math.max(0, actual ? n(bank.profit) : n(plannedProfit)), planned: !actual };
}

// Actual cash performance outranks a reserve total. A losing/flat month with bills still due must
// never look like an ordinary transfer prompt. Planned fallbacks are also labeled explicitly so the
// owner knows the number came from Budget settings rather than a current bank feed.
export function classifyPlanStatus({ bank, total, commitments, plannedProfit, plannedConfigured, configuredObligations, verifiedCovered }) {
  const current = bank?.status === "current" && n(bank.currentCount) > 0;
  if (current && n(bank.profit) < 0) return commitments > 0 ? "cash_shortfall" : "negative_cashflow";
  if (current && n(bank.profit) === 0) return commitments > 0 ? "cash_tight" : "no_profit";
  if (current && n(total) > Math.max(0, n(bank.profit))) return "cash_tight";
  if (!current && n(plannedProfit) < 0 && commitments > 0) return "planned_shortfall";
  if (!current && n(plannedProfit) === 0 && commitments > 0) return "planned_tight";
  if (!current && n(total) > Math.max(0, n(plannedProfit))) return "planned_shortfall";
  if (n(total) > 0) return current ? "actionable" : "planned_target";
  if (!plannedConfigured && !configuredObligations && !current) return "setup";
  if (verifiedCovered) return "covered";
  return current ? "no_reserve_actual" : "no_reserve";
}

async function buildPlan() {
  const [budgetRead, costsRead] = await Promise.all([sbGetPlanInput("sps_budget", {}), sbGetPlanInput("sps_costs", {})]);
  const et = etNow();
  if (!budgetRead.ok || !costsRead.ok) {
    return {
      et, status: "unavailable", bank: null, planned: null, taxes: 0, taxesPlanned: false,
      payroll: { remaining: 0, runsLeft: 0, next: null, amount: 0 }, debtRemaining: 0,
      goalsMonthly: 0, total: 0, config: { tax: false, payroll: false, debt: false, goals: false },
    };
  }
  const budget = budgetRead.value || {}, costs = costsRead.value || {};
  const bank = await fetchBank(budget);

  // Taxes: real bank profit when connected; the budget's PLANNED profit otherwise. The planned
  // side must subtract the fixed monthly overhead lines — the app adds them to every expense
  // figure (monthlyFixedCosts), so skipping them here would overstate profit and the tax line.
  const costLine = (v) => (v && typeof v === "object") ? v : { amount: String(v == null ? "0" : v), mode: "stop" };
  const fixedMo = ["gas", "insurance", "equipment", "overhead"].reduce((s, k) => { const l = costLine(costs[k]); return s + (l.mode === "month" ? n(l.amount) : 0); }, 0);
  const plannedIncome = (budget.income || []).reduce((s, r) => s + n(r.amount), 0);
  const plannedExpense = (budget.expenses || []).reduce((s, r) => s + n(r.amount), 0) + fixedMo;
  const plannedProfit = plannedIncome - plannedExpense;
  const plannedConfigured = (budget.income || []).length > 0 || (budget.expenses || []).length > 0 || fixedMo > 0;
  // A connected account with zero selected transactions is not an actual $0 month. In that case,
  // use the owner's budget targets and label the result as planned instead of silently discarding
  // a useful plan (the defect that produced the repeated screenshot message).
  const basis = chooseProfitBasis(bank, plannedProfit);
  const profitMo = basis.profit;
  const taxes = monthlyTaxSetAside(profitMo, costs.tax);

  const payroll = payrollPlan(costs.payroll, bank && bank.payrollDetected, et);

  // Debt minimums not yet covered this month (marks-aware: payments the owner tagged count).
  const ym = `${et.y}-${pad2(et.m)}`;
  const marks = Object.values(budget.txMarks || {});
  const debts = (budget.debts || []).filter((d) => n(d.balance) > 0);
  let debtScheduled = 0, debtPaid = 0;
  const debtRemaining = debts.reduce((s, d) => {
    const due = n(d.minPayment) || n(d.monthlyPayment);
    if (!due) return s;
    const paid = Math.max(0, marks.filter((m) => m && m.kind === "debt" && m.debtId === d.id && String(m.date || "").startsWith(ym)).reduce((a, m) => a + (-(m.amount) || 0), 0));
    debtScheduled += due; debtPaid += Math.min(due, paid);
    return s + Math.max(0, due - paid);
  }, 0);

  // Goal plans net out what's already been marked to each goal this month (same semantics as debts).
  let goalsScheduled = 0, goalsPaid = 0;
  const goalsMonthly = (budget.goals || []).reduce((s, g) => {
    const plan = n(g.monthly);
    if (!plan) return s;
    const paid = Math.max(0, marks.filter((m) => m && m.kind === "savings" && m.goalId === g.id && String(m.date || "").startsWith(ym)).reduce((a, m) => a + (-(m.amount) || 0), 0));
    goalsScheduled += plan; goalsPaid += Math.min(plan, paid);
    return s + Math.max(0, plan - paid);
  }, 0);

  const total = taxes + payroll.remaining + debtRemaining + goalsMonthly;
  const config = {
    tax: costs?.tax?.enabled !== false,
    payroll: !!(costs?.payroll?.freq && payroll.amount > 0),
    debt: debtScheduled > 0,
    goals: goalsScheduled > 0,
  };
  const verifiedCovered = (debtScheduled > 0 || goalsScheduled > 0)
    && debtRemaining === 0 && goalsMonthly === 0
    && debtPaid >= debtScheduled && goalsPaid >= goalsScheduled;
  const commitments = payroll.remaining + debtRemaining + goalsMonthly;
  const status = classifyPlanStatus({
    bank, total, commitments, plannedProfit, plannedConfigured,
    configuredObligations: config.payroll || config.debt || config.goals,
    verifiedCovered,
  });

  return {
    et, status,
    bank: { status: bank.status, income: bank.income, expense: bank.expense, profit: bank.profit, currentCount: bank.currentCount, lastDate: bank.lastDate },
    planned: { configured: plannedConfigured, income: plannedIncome, expense: plannedExpense, profit: plannedProfit },
    taxes, taxesPlanned: basis.planned, payroll, debtRemaining, goalsMonthly, commitments, total, config,
  };
}

function asciiSms(text) {
  return String(text || "").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

function smsChoice(primary, fallback) {
  const first = asciiSms(primary);
  if (first.length <= 160) return first;
  const second = asciiSms(fallback);
  return second.length <= 160 ? second : `${second.slice(0, 157).trimEnd()}...`;
}

export function planMessage(plan, branding = {}) {
  const brand = asciiSms(branding.moneyPlanLabel || branding.shortName || "SPS").slice(0, 20) || "SPS";
  const parts = [];
  if (plan.taxes > 0) parts.push(`tax ${money(plan.taxes)}`);
  if (plan.payroll?.remaining > 0) parts.push(`payroll ${money(plan.payroll.remaining)}`);
  if (plan.debtRemaining > 0) parts.push(`debt ${money(plan.debtRemaining)}`);
  if (plan.goalsMonthly > 0) parts.push(`goals ${money(plan.goalsMonthly)}`);
  const status = plan.status || (n(plan.total) > 0 ? "actionable" : "no_reserve");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(plan.et?.m || new Date().getMonth() + 1) - 1];
  const bank = plan.bank || {};
  const planned = plan.planned || {};
  const commitments = n(plan.commitments) || n(plan.payroll?.remaining) + n(plan.debtRemaining) + n(plan.goalsMonthly);

  if (status === "actionable") {
    return smsChoice(
      `${brand} money plan: reserve target ${money(plan.total)}: ${parts.join(", ")}. Target only; do not transfer twice. Open SPS Way > Budget.`,
      `${brand} money plan: reserve target ${money(plan.total)}. Review the breakdown in SPS Way > Budget. Target only; do not transfer twice.`,
    );
  }
  if (status === "planned_target") {
    const feed = bank.status === "unavailable" ? "Bank Sync is unavailable." : bank.status === "not_connected" ? "Bank Sync is not connected." : "No current bank activity.";
    return smsChoice(
      `${brand} money plan: ${feed} Planned target ${money(plan.total)}: ${parts.join(", ")}. Review in SPS Way > Budget before moving money.`,
      `${brand} money plan: ${feed} Planned reserve target ${money(plan.total)}. Review it in SPS Way > Budget before moving money.`,
    );
  }
  if (status === "cash_shortfall" || status === "negative_cashflow") {
    if (commitments > 0) return smsChoice(
      `${brand} money plan: ${month} MTD net ${money(bank.profit)}. Commitments left: ${parts.join(", ")}. Check cash first in SPS Way > Budget.`,
      `${brand} money plan: ${month} MTD net ${money(bank.profit)}; ${money(commitments)} commitments remain. Check cash before moving funds in SPS Way > Budget.`,
    );
    return smsChoice(
      `${brand} money plan: ${month} MTD in ${money(bank.income)}, out ${money(bank.expense)}, net ${money(bank.profit)}. No tax reserve recommended. Next: review cash and bills in SPS Way > Budget.`,
      `${brand} money plan: ${month} MTD net is ${money(bank.profit)}, so no tax reserve is recommended. Next: review cash and bills in SPS Way > Budget.`,
    );
  }
  if (status === "cash_tight") {
    return smsChoice(
      `${brand} money plan: ${month} MTD net ${money(bank.profit)}. Targets total ${money(plan.total)}: ${parts.join(", ")}. Check available cash in SPS Way > Budget.`,
      `${brand} money plan: ${month} MTD net ${money(bank.profit)}; targets total ${money(plan.total)}. Check available cash before moving funds. Review SPS Way > Budget.`,
    );
  }
  if (status === "no_profit") {
    return `${brand} money plan: ${month} MTD net is $0, so no tax reserve is recommended. Next: review cash and upcoming bills in SPS Way > Budget.`;
  }
  if (status === "planned_shortfall" || status === "planned_tight") {
    return smsChoice(
      `${brand} money plan: budgeted net ${money(planned.profit)}; targets total ${money(plan.total)}: ${parts.join(", ")}. Check available cash in SPS Way > Budget.`,
      `${brand} money plan: budgeted net ${money(planned.profit)}; targets total ${money(plan.total)}. Check cash before any transfer in SPS Way > Budget.`,
    );
  }
  if (status === "unavailable") {
    return `${brand} money plan: data could not load, so no target was calculated. No money action is recommended. Retry from SPS Way > Budget.`;
  }
  if (status === "setup") {
    return `${brand} money plan needs setup: no current bank activity or Budget targets were found. Connect Bank Sync or add targets in SPS Way > Budget.`;
  }
  if (status === "covered") {
    return `${brand} money plan: recorded debt and goal targets are covered. Tax reserves are not tracked as paid. Review the details in SPS Way > Budget.`;
  }
  if (status === "no_reserve_actual") {
    return smsChoice(
      `${brand} money plan: ${month} MTD in ${money(bank.income)}, out ${money(bank.expense)}, net ${money(bank.profit)}; reserve target is $0. Review settings in SPS Way > Budget.`,
      `${brand} money plan: ${month} MTD net ${money(bank.profit)}; reserve target is $0. Review tax, payroll, debt and goal settings in SPS Way > Budget.`,
    );
  }
  return smsChoice(
    `${brand} money plan: $0 planned reserve target. Budget: in ${money(planned.income)}, out ${money(planned.expense)}, net ${money(planned.profit)}. Review SPS Way > Budget.`,
    `${brand} money plan: $0 planned reserve target. Review tax, payroll, debt and goal settings in SPS Way > Budget.`,
  );
}

export function planSignature(plan, branding = {}) {
  // Dedupe what the owner actually receives, not hidden inputs. Net-neutral transaction changes
  // should not cause an identical weekly text to be sent again.
  const payload = `${plan.et?.ym || ""}\n${planMessage(plan, branding)}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

export function shouldSuppressUnchangedPlan(ledger, plan) {
  return !!ledger && ledger.month === plan.et?.ym && ledger.signature === planSignature(plan);
}

function normalizedRecipient(channel, recipient) {
  return channel === "sms" ? toE164(recipient) : String(recipient || "").trim().toLowerCase();
}

export function recipientSignature(channel, recipient, secret = CRON_SECRET || SERVICE_KEY || "sps-money-plan-test") {
  return createHmac("sha256", secret).update(`${String(channel || "").toLowerCase()}\n${normalizedRecipient(channel, recipient)}`).digest("hex").slice(0, 24);
}

export function deliverySignature(plan, channel, recipient, payload = planMessage(plan), secret = CRON_SECRET || SERVICE_KEY || "sps-money-plan-test") {
  const material = `${plan.et?.ym || ""}\n${String(channel || "").toLowerCase()}\n${normalizedRecipient(channel, recipient)}\n${payload}`;
  return createHmac("sha256", secret).update(material).digest("hex").slice(0, 32);
}

const objectLedger = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

// Pure half of the pre-send CAS. Jobs contain only opaque signatures/tokens; raw recipients and
// financial message text are never persisted. A durable claim is written before contacting either
// provider, preventing overlapping Vercel cron invocations from sending the same delivery twice.
export function claimMoneyPlanDeliveries(current, jobs, meta = {}) {
  const latest = objectLedger(current);
  const deliveries = objectLedger(latest.deliveries);
  const nowIso = meta.nowIso || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const leaseUntil = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 24 * 60 * 60 * 1000).toISOString();
  const hasV2 = Object.keys(deliveries).length > 0;
  // Preserve the old same-day guarantee while the live ledger migrates to per-channel entries.
  if (!hasV2 && meta.sendDate && latest.sent === meta.sendDate) return { changed: false, value: latest, claimed: [] };

  const nextDeliveries = { ...deliveries };
  const claimed = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job?.key || !job?.channel || !job?.token) continue;
    const existing = objectLedger(nextDeliveries[job.key]);
    if (["sent", "uncertain", "claimed"].includes(existing.state)) continue;
    if (existing.state === "failed") {
      const retryAt = Date.parse(existing.retryAfter || "");
      if (!existing.retryable || n(existing.attempt) >= 3 || (Number.isFinite(retryAt) && retryAt > nowMs)) continue;
    }
    // Keep the original once-per-day behavior per destination even if a bank transaction changes
    // the target later that day. A genuinely changed recipient has a different opaque fingerprint.
    const alreadySentToday = Object.values(nextDeliveries).some((entry) =>
      entry?.channel === job.channel && entry?.recipientKey === job.recipientKey
      && entry?.sendDate === meta.sendDate && ["sent", "uncertain"].includes(entry?.state)
    );
    if (alreadySentToday) continue;
    // A settings change may create a new recipient signature. Do not race it against an in-flight
    // delivery on the same channel; an expired old claim no longer blocks a genuinely new key.
    const activeSameChannel = Object.entries(nextDeliveries).some(([key, entry]) => {
      if (key === job.key || entry?.channel !== job.channel || entry?.state !== "claimed") return false;
      const until = Date.parse(entry.leaseUntil || "");
      return !Number.isFinite(until) || until > nowMs;
    });
    if (activeSameChannel) continue;
    nextDeliveries[job.key] = {
      channel: job.channel, state: "claimed", token: job.token,
      claimedAt: nowIso, leaseUntil, attempt: Math.max(0, n(existing.attempt)) + 1,
      month: meta.month || "", sendDate: meta.sendDate || "", recipientKey: job.recipientKey || "",
      planSignature: meta.planSignature || "",
    };
    claimed.push(job.channel);
  }
  if (!claimed.length) return { changed: false, value: latest, claimed };
  return { changed: true, claimed, value: { ...latest, schema: 2, deliveries: nextDeliveries } };
}

// Pure half of the post-send CAS. Network ambiguity is deliberately terminal for this exact
// payload: at-most-once is safer than a duplicate financial prompt. Explicit 429 rejections can
// retry after one hour, at most three attempts, without resending channels already delivered.
export function finalizeMoneyPlanDeliveries(current, jobs, results, meta = {}) {
  const latest = objectLedger(current);
  const deliveries = objectLedger(latest.deliveries);
  const nextDeliveries = { ...deliveries };
  const nowIso = meta.nowIso || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  let changed = false, anySent = false;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const existing = objectLedger(nextDeliveries[job.key]);
    if (existing.state !== "claimed" || existing.token !== job.token) continue;
    const result = objectLedger(results?.[job.channel]);
    const { token: _token, leaseUntil: _leaseUntil, ...base } = existing;
    if (result.ok) {
      nextDeliveries[job.key] = { ...base, state: "sent", sentAt: nowIso };
      anySent = true;
    } else if (result.uncertain) {
      nextDeliveries[job.key] = { ...base, state: "uncertain", uncertainAt: nowIso };
    } else {
      nextDeliveries[job.key] = {
        ...base, state: "failed", failedAt: nowIso, retryable: !!result.retryable,
        retryAfter: result.retryable ? new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 60 * 60 * 1000).toISOString() : null,
      };
    }
    changed = true;
  }
  if (!changed) return { changed: false, value: latest };
  const value = { ...latest, schema: 2, deliveries: nextDeliveries };
  if (anySent) Object.assign(value, {
    sent: meta.sendDate || latest.sent, month: meta.month || latest.month,
    signature: meta.planSignature || latest.signature, status: meta.status || latest.status,
    sentAt: nowIso,
  });
  return { changed: true, value };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};
  // Explicit ?check only — Vercel's cron hits this path as a BARE GET, which must fall through to
  // the cron branch below (it then 401s without CRON_SECRET, same posture as owner-digest).
  if (q.check) {
    return res.status(200).json({ ok: true, configured: { quo: !!(QUO_KEY && QUO_FROM), resend: !!RESEND_KEY, supabase: !!SERVICE_KEY } });
  }
  if (!SERVICE_KEY) return res.status(501).json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY" });

  const test = q.test === "1", preview = q.preview === "1";
  if (test || preview) {
    const u = await requireOwner(req, res, "the money plan"); if (!u) return;
  } else {
    const cronOk = !!CRON_SECRET && req.headers.authorization === `Bearer ${CRON_SECRET}`;
    if (!cronOk) return res.status(401).json({ error: "unauthorized", hint: "cron runs require CRON_SECRET; use ?test=1 signed in as the owner" });
  }

  // Read the small schedule row first. Most hourly invocations are off, before the send hour, or on
  // the wrong day; those runs should not download branding/email or begin the heavier bank plan.
  const cfgAll = await sbGet("sps_schedule_cfg", {});
  const cfg = cfgAll.transferNudge || {};
  let et = null;
  if (!test && !preview) {
    if (!cfg.on) return res.status(200).json({ ok: true, skipped: "nudge is off" });
    et = etNow();
    const sendHour = Number.isFinite(+cfg.hour) ? Math.min(23, Math.max(0, Math.round(+cfg.hour))) : 8;
    if (et.hour < sendHour) return res.status(200).json({ ok: true, note: `before send hour (ET ${et.hour}:00 < ${sendHour}:00)` });
    const lastDom = new Date(Date.UTC(et.y, et.m, 0)).getUTCDate();
    const due = cfg.freq === "monthly"
      ? et.day === Math.min(Math.max(1, Math.round(+cfg.monthDay) || 1), lastDom)
      : et.weekday === (Number.isFinite(+cfg.weekday) ? Math.min(6, Math.max(0, Math.round(+cfg.weekday))) : 5);
    if (!due) return res.status(200).json({ ok: true, note: "not the scheduled day" });
  }

  const [branding, email] = await Promise.all([
    sbGet("sps_branding", {}),
    sbGet("sps_email", {}),
  ]);
  // Wired to the SAME sending settings the working sends already use — zero extra setup:
  //   texts  → the Owner-Alerts contact (email.notify.ownerPhone — where visit/alert texts to the
  //            owner go), then the Test-Mode redirect phone.
  //   emails → the report recipient (ownerDigest.to — where the daily/weekly reports go), then the
  //            Owner-Alerts email → owner email → company email.
  // The card's inputs are optional OVERRIDES only. Still NO company-phone fallback for texts: the
  // business line can be public (or the Quo number itself) and this is the owner's private money.
  const notify = email.notify || {}, tmode = email.testMode || {};
  const toPhone = cfg.toPhone || notify.ownerPhone || tmode.phone || "";
  const toEmail = cfg.toEmail || (cfgAll.ownerDigest && cfgAll.ownerDigest.to) || notify.ownerEmail || email.ownerEmail || branding.companyEmail || "";

  if (test || preview) {
    const plan = await buildPlan();
    const message = planMessage(plan, branding);
    if (preview) return res.status(200).json({ ok: true, plan, message });
    const channel = cfg.channel || "email";
    const out = {};
    if (channel === "sms" || channel === "both") out.sms = await sendQuo(toPhone, message);
    if (channel === "email" || channel === "both") out.email = await sendEmail(toEmail, `${branding.companyName || "SPS"} — money plan`, message, branding);
    const sent = Object.values(out).some((r) => r && r.ok);
    await logNudge(out, "money plan (test button)");
    // Push mirror — added AFTER the sent calculation so it never influences it.
    out.push = await pushOwner("reports", `${branding.companyName || "SPS"} money plan`, message, "budget", { email, collapseId: "nudge-test" });
    return res.status(sent ? 200 : 400).json({ ok: sent, test: true, ...out });
  }

  // ── real (cron) run ──
  const plan = await buildPlan();
  const message = planMessage(plan, branding);
  const signature = planSignature(plan, branding);
  const channel = cfg.channel || "email";
  const subject = `${branding.companyName || "SPS"} — money plan`;
  const batchId = randomUUID();
  const jobs = [];
  if (channel === "sms" || channel === "both") jobs.push({
    channel: "sms", token: `${batchId}:sms`,
    recipientKey: recipientSignature("sms", toPhone),
    key: deliverySignature(plan, "sms", toPhone, message),
  });
  if (channel === "email" || channel === "both") jobs.push({
    channel: "email", token: `${batchId}:email`,
    recipientKey: recipientSignature("email", toEmail),
    // Include the subject and template version because those are part of the actual email payload.
    key: deliverySignature(plan, "email", toEmail, `money-plan-email-v2\n${subject}\n${message}`),
  });
  if (!jobs.length) return res.status(200).json({ ok: false, skipped: "no delivery channel configured" });

  // Claim every requested channel in one strict CAS BEFORE any provider call. If Supabase cannot
  // prove the delivery is new, fail closed and send nothing.
  let claimResult;
  const claimNow = new Date().toISOString();
  try {
    claimResult = await mutateAppState("sps_nudge_log", (current) => {
      const claim = claimMoneyPlanDeliveries(current, jobs, {
        nowIso: claimNow, sendDate: et.mdy, month: plan.et?.ym || et.ym,
        planSignature: signature,
      });
      return claim.changed ? claim.value : NO_APP_STATE_CHANGE;
    });
  } catch (error) {
    console.error("money-plan claim failed:", error && error.message ? error.message : error);
    return res.status(503).json({ ok: false, error: "The money plan could not verify its delivery ledger, so nothing was sent." });
  }
  const claimedJobs = jobs.filter((job) => {
    const entry = claimResult.value?.deliveries?.[job.key];
    return entry?.state === "claimed" && entry?.token === job.token;
  });
  if (!claimedJobs.length) {
    return res.status(200).json({ ok: true, note: "money plan is unchanged, already delivered, or currently being delivered" });
  }

  const out = {};
  await Promise.all(claimedJobs.map(async (job) => {
    if (job.channel === "sms") out.sms = await sendQuo(toPhone, message);
    if (job.channel === "email") out.email = await sendEmail(toEmail, subject, message, branding);
  }));

  let finalizeResult;
  const finalizedAt = new Date().toISOString();
  try {
    finalizeResult = await mutateAppState("sps_nudge_log", (current) => {
      const finalized = finalizeMoneyPlanDeliveries(current, claimedJobs, out, {
        nowIso: finalizedAt, sendDate: et.mdy, month: plan.et?.ym || et.ym,
        planSignature: signature, status: plan.status || "unknown",
      });
      return finalized.changed ? finalized.value : NO_APP_STATE_CHANGE;
    });
    if (!finalizeResult.changed) throw new Error("money_plan_claim_mismatch");
  } catch (error) {
    console.error("money-plan ledger finalization failed:", error && error.message ? error.message : error);
    return res.status(502).json({ ok: false, error: "The money plan attempted delivery, but its delivery ledger could not be finalized. It will not auto-resend this payload.", ...out });
  }

  const requestedStates = jobs.map((job) => finalizeResult.value?.deliveries?.[job.key]?.state);
  const allSent = requestedStates.every((state) => state === "sent");
  const anySent = requestedStates.some((state) => state === "sent");
  await logNudge(out, "money plan (auto)");
  // Push mirrors only a confirmed SMS/email delivery and uses the exact-message signature as its
  // collapse key, so provider retries cannot create another visible copy.
  if (Object.values(out).some((result) => result?.ok)) {
    out.push = await pushOwner("reports", `${branding.companyName || "SPS"} money plan`, message, "budget", { email, collapseId: `nudge-${signature}` });
  }
  return res.status(200).json({ ok: allSent, partial: anySent && !allSent, ...out });
}
