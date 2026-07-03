// api/transfer-nudge.js
// The "money plan" nudge — the app can't (and shouldn't) move money, so it does the thinking and
// texts/emails the owner the exact transfer to make: taxes to set aside (from REAL bank profit +
// the tax config), payroll runs still to cover this month (from the payroll config + Gusto debits
// detected in the bank feed), debt minimums not yet paid (marks-aware), and planned savings-goal
// contributions. The owner executes the transfer in their bank — the app never touches funds.
//
// Modes (mirrors api/owner-digest.js):
//   GET ?check   → { configured: { quo, resend, plaid } }
//   ?preview=1   → OWNER-gated: computed plan JSON + the message text (drives the in-app card).
//   ?test=1      → OWNER-gated: sends the nudge to the owner NOW (whatever channels are configured).
//   (cron)       → hourly with CRON_SECRET: sends when due (freq/day/hour ET) once per day (ledger).
//
// Config in sps_schedule_cfg.transferNudge = { on, freq: "weekly"|"monthly", weekday(0-6),
// monthDay(1-28), hour (ET, default 8), channel: "sms"|"email"|"both", toPhone?, toEmail? }.
// Payroll config in sps_costs.payroll = { freq: ""|"weekly"|"biweekly"|"monthly",
// anchor: "YYYY-MM-DD" (a recent payday), amount: "" (typical all-in cost per run; blank → detect) }.
// Ledger in sps_nudge_log (separate key so the cron never rewrites the app-edited cfg).

import { getItem, plaidCall, requireOwner } from "./plaid/_plaid.js";
import { pushOwner } from "./_push.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const QUO_KEY      = process.env.QUO_API_KEY;
const QUO_FROM     = process.env.QUO_PHONE_NUMBER;
const CRON_SECRET  = process.env.CRON_SECRET;

const n = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
const money = (v) => `$${Math.round(n(v)).toLocaleString()}`;
const pad2 = (x) => String(x).padStart(2, "0");

// ── app_state (service-role) ──────────────────────────────────────────────────────────────────────
const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const parseVal = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
async function sbGet(key, fallback) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
    if (!r.ok) return fallback;
    const rows = await r.json().catch(() => []);
    const v = rows && rows[0] ? parseVal(rows[0].value) : null;
    return v == null ? fallback : v;
  } catch { return fallback; }
}
async function sbSet(key, obj) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=key`, {
    method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value: JSON.stringify(obj) }]),
  });
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
async function sendQuo(to, message, fromOverride) {
  // Same "from" resolution as the app's texts (api/send-sms): the configured Sending Identity
  // texting number when set, else the server default.
  const toNum = toE164(to), fromNum = toE164(fromOverride) || toE164(QUO_FROM);
  if (!QUO_KEY || !fromNum) return { ok: false, error: "texting not configured (QUO_API_KEY / QUO_PHONE_NUMBER)" };
  if (!toNum) return { ok: false, error: "no number found — set your Owner Alerts phone (Customize → Communications) or type one on the nudge card" };
  if (toNum === fromNum) return { ok: false, error: "owner phone matches the business texting number — set your personal number" };
  try {
    const r = await fetch("https://api.quo.com/v1/messages", {
      method: "POST", headers: { Authorization: QUO_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(message), from: fromNum, to: [toNum] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data?.message || data?.error || `Quo ${r.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || "network" }; }
}
async function sendEmail(to, subject, textBody, branding) {
  if (!RESEND_KEY) return { ok: false, error: "email not configured (RESEND_API_KEY)" };
  if (!to || !/.+@.+\..+/.test(to)) return { ok: false, error: "no owner email — set one on the nudge or in settings" };
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = textBody.split("\n").map((l) => `<div style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#26211C;">${esc(l)}</div>`).join("");
  const html = `<div style="max-width:520px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
    <div style="font-size:17px;font-weight:800;color:#26211C;margin-bottom:14px;">${esc(branding.companyName || "Stone Property Solutions")} — money plan</div>
    <div style="background:#faf9f7;border:1px solid #e8e5e0;border-radius:14px;padding:18px;">${rows}</div>
    <div style="font-size:11px;color:#8a857e;margin-top:12px;">You move the money — the app never can. General guidance, not financial advice.</div>
  </div>`;
  const from = process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text: textBody }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d?.message || `Resend ${r.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || "network" }; }
}

// ── bank: this month's marks-aware summary + payroll detection (server twin of the app's engine) ──
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const PAYROLL_RE = /gusto|payroll|adp\b|paychex|paycor|onpay|heartland payroll|intuit.*payroll|quickbooks payroll/i;
async function fetchBank(budget) {
  const item = await getItem();
  if (!item || !item.access_token) return null;
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
  } catch { return null; } // bank unreachable → caller falls back to planned numbers
  const txns = all.map((t) => ({ id: t.transaction_id || "", pendingId: t.pending_transaction_id || null, date: t.date || "", name: t.merchant_name || t.name || "", amount: -(t.amount || 0), category: (t.personal_finance_category && t.personal_finance_category.primary) || "" }));

  const marks = (budget && budget.txMarks) || {}, rules = (budget && budget.txRules) || {};
  // Same pre-migration posture as the app: a mark keyed on the pending twin still counts.
  const markOf = (t) => marks[t.id] || (t.pendingId && marks[t.pendingId]) || rules[norm(t.name)] || null;
  const effKind = (t) => { const m = markOf(t); return (m && m.kind) || (t.amount >= 0 ? "income" : "expense"); };

  const et = etNow();
  const ym = `${et.y}-${pad2(et.m)}`;
  let income = 0, expense = 0;
  txns.forEach((t) => {
    if (!t.date.startsWith(ym)) return;
    const k = effKind(t);
    if (k === "ignore") return;
    if (k === "income") income += t.amount;
    else if (k === "expense") expense += -t.amount;
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
  return { income: Math.max(0, income), expense: Math.max(0, expense), profit: income - expense, payrollDetected };
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
async function buildPlan() {
  const [budget, costs] = await Promise.all([sbGet("sps_budget", {}), sbGet("sps_costs", {})]);
  const et = etNow();
  const bank = await fetchBank(budget);

  // Taxes: real bank profit when connected; the budget's PLANNED profit otherwise. The planned
  // side must subtract the fixed monthly overhead lines — the app adds them to every expense
  // figure (monthlyFixedCosts), so skipping them here would overstate profit and the tax line.
  const costLine = (v) => (v && typeof v === "object") ? v : { amount: String(v == null ? "0" : v), mode: "stop" };
  const fixedMo = ["gas", "insurance", "equipment", "overhead"].reduce((s, k) => { const l = costLine(costs[k]); return s + (l.mode === "month" ? n(l.amount) : 0); }, 0);
  const plannedProfit = Math.max(0, (budget.income || []).reduce((s, r) => s + n(r.amount), 0) - (budget.expenses || []).reduce((s, r) => s + n(r.amount), 0) - fixedMo);
  const profitMo = bank ? Math.max(0, bank.profit) : plannedProfit;
  const taxes = monthlyTaxSetAside(profitMo, costs.tax);

  const payroll = payrollPlan(costs.payroll, bank && bank.payrollDetected, et);

  // Debt minimums not yet covered this month (marks-aware: payments the owner tagged count).
  const ym = `${et.y}-${pad2(et.m)}`;
  const marks = Object.values(budget.txMarks || {});
  const debts = (budget.debts || []).filter((d) => n(d.balance) > 0);
  const debtRemaining = debts.reduce((s, d) => {
    const due = n(d.minPayment) || n(d.monthlyPayment);
    if (!due) return s;
    const paid = Math.max(0, marks.filter((m) => m && m.kind === "debt" && m.debtId === d.id && String(m.date || "").startsWith(ym)).reduce((a, m) => a + (-(m.amount) || 0), 0));
    return s + Math.max(0, due - paid);
  }, 0);

  // Goal plans net out what's already been marked to each goal this month (same semantics as debts).
  const goalsMonthly = (budget.goals || []).reduce((s, g) => {
    const plan = n(g.monthly);
    if (!plan) return s;
    const paid = Math.max(0, marks.filter((m) => m && m.kind === "savings" && m.goalId === g.id && String(m.date || "").startsWith(ym)).reduce((a, m) => a + (-(m.amount) || 0), 0));
    return s + Math.max(0, plan - paid);
  }, 0);

  const total = taxes + payroll.remaining + debtRemaining + goalsMonthly;
  return { et, bank: bank ? { income: bank.income, expense: bank.expense, profit: bank.profit } : null,
    taxes, taxesPlanned: !bank, payroll, debtRemaining, goalsMonthly, total };
}

function planMessage(plan, branding) {
  const parts = [];
  if (plan.taxes > 0) parts.push(`${money(plan.taxes)} taxes${plan.taxesPlanned ? " (planned)" : ""}`);
  if (plan.payroll.remaining > 0) parts.push(`${money(plan.payroll.remaining)} payroll (${plan.payroll.runsLeft} run${plan.payroll.runsLeft === 1 ? "" : "s"}${plan.payroll.next ? `, next ${plan.payroll.next}` : ""})`);
  if (plan.debtRemaining > 0) parts.push(`${money(plan.debtRemaining)} debt minimums`);
  if (plan.goalsMonthly > 0) parts.push(`${money(plan.goalsMonthly)} savings goals`);
  const co = branding.companyName || "SPS";
  if (!parts.length) return `${co} money plan: nothing left to set aside this month — taxes, payroll, debts, and goals are covered. Nice.`;
  const bankLine = plan.bank ? ` Bank this month: in ${money(plan.bank.income)}, out ${money(plan.bank.expense)}.` : "";
  return `${co} money plan — keep ${money(plan.total)} set aside this month: ${parts.join(" + ")}.${bankLine} Move it in your bank when ready (the app never touches funds).`;
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

  const [cfgAll, branding, email] = await Promise.all([
    sbGet("sps_schedule_cfg", {}), sbGet("sps_branding", {}), sbGet("sps_email", {}),
  ]);
  const cfg = cfgAll.transferNudge || {};
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

  const test = q.test === "1", preview = q.preview === "1";
  if (test || preview) {
    const u = await requireOwner(req, res, "the money plan"); if (!u) return;
    const plan = await buildPlan();
    const message = planMessage(plan, branding);
    if (preview) return res.status(200).json({ ok: true, plan, message });
    const channel = cfg.channel || "email";
    const out = {};
    if (channel === "sms" || channel === "both") out.sms = await sendQuo(toPhone, message, email.textingNumber);
    if (channel === "email" || channel === "both") out.email = await sendEmail(toEmail, `${branding.companyName || "SPS"} — money plan`, message, branding);
    const sent = Object.values(out).some((r) => r && r.ok);
    // Push mirror — added AFTER the sent calculation so it never influences it.
    out.push = await pushOwner("reports", `${branding.companyName || "SPS"} money plan`, message, "budget", { email, collapseId: "nudge-test" });
    return res.status(sent ? 200 : 400).json({ ok: sent, test: true, ...out });
  }

  // ── real (cron) run ──
  const cronOk = !!CRON_SECRET && req.headers.authorization === `Bearer ${CRON_SECRET}`;
  if (!cronOk) return res.status(401).json({ error: "unauthorized", hint: "cron runs require CRON_SECRET; use ?test=1 signed in as the owner" });
  if (!cfg.on) return res.status(200).json({ ok: true, skipped: "nudge is off" });

  const et = etNow();
  const sendHour = Number.isFinite(+cfg.hour) ? Math.min(23, Math.max(0, Math.round(+cfg.hour))) : 8;
  if (et.hour < sendHour) return res.status(200).json({ ok: true, note: `before send hour (ET ${et.hour}:00 < ${sendHour}:00)` });
  const lastDom = new Date(Date.UTC(et.y, et.m, 0)).getUTCDate();
  const due = cfg.freq === "monthly"
    ? et.day === Math.min(Math.max(1, Math.round(+cfg.monthDay) || 1), lastDom)
    : et.weekday === (Number.isFinite(+cfg.weekday) ? Math.min(6, Math.max(0, Math.round(+cfg.weekday))) : 5);
  if (!due) return res.status(200).json({ ok: true, note: "not the scheduled day" });

  const ledger = await sbGet("sps_nudge_log", {});
  if (ledger.sent === et.mdy) return res.status(200).json({ ok: true, note: "already sent today" });

  const plan = await buildPlan();
  const message = planMessage(plan, branding);
  const channel = cfg.channel || "email";
  const out = {};
  if (channel === "sms" || channel === "both") out.sms = await sendQuo(toPhone, message, email.textingNumber);
  if (channel === "email" || channel === "both") out.email = await sendEmail(toEmail, `${branding.companyName || "SPS"} — money plan`, message, branding);
  const sent = Object.values(out).some((r) => r && r.ok);
  if (sent) await sbSet("sps_nudge_log", { ...ledger, sent: et.mdy });
  // Push mirror — after the sent/ledger decision so a push-only success can't stamp the ledger
  // and suppress the real SMS/email retry next hour. collapseId dedupes hourly retries.
  out.push = await pushOwner("reports", `${branding.companyName || "SPS"} money plan`, message, "budget", { email, collapseId: `nudge-${et.mdy}` });
  return res.status(200).json({ ok: sent, ...out });
}
