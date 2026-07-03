// api/owner-digest.js
// Owner-only DAILY / WEEKLY / MONTHLY business report email. Each interval reports on ITS OWN window:
//   daily   → yesterday's activity + today's agenda
//   weekly  → the last 7 days
//   monthly → the previous full calendar month (sent on the configured day, e.g. the 1st)
// Every report carries a financial snapshot (collected, outstanding, overdue, work done, profit,
// avg/job), a running tally (month-to-date on daily/weekly, year-to-date on monthly), A/R aging, a
// per-tech breakdown, invoices still owed, what got done (stops + notes + payments), and today's agenda.
// Reads app_state server-side with the SERVICE_ROLE key and sends via Resend. Only ever emails the
// OWNER — INDEPENDENT of the client-comms master switch + Test Mode; gated by its own toggles.
//
// Gating:
//   ?dryRun=1  (OWNER, signed in) → returns the computed reports JSON, sends nothing.
//   ?test=1    (OWNER, signed in) → emails today's DAILY report to the owner now.
//   cron (Authorization: Bearer CRON_SECRET) → sends daily/weekly/monthly when due (config + ET hour), deduped.
//
// Config: sps_schedule_cfg.ownerDigest = { dailyOn, weeklyOn, monthlyOn, hour (ET 0-23), weekday (0=Sun), monthDay, to }.
// Recipient falls back to sps_email.ownerEmail → sps_branding.companyEmail.
// Env (Vercel): SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, CRON_SECRET. Optional SUPABASE_URL, RESEND_FROM.

import { verifyUser } from "./_auth.js";
import { resolveFrom } from "./_sender.js";
import { pushOwner } from "./_push.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const DEFAULT_LOGO = "https://spsway.app/icon-512.png";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

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

// ── date helpers (date-only, DST-proof via civil YYYYMMDD integers) ──────────────────────────────
const pad2 = (n) => String(n).padStart(2, "0");
function toMDY(s) {
  if (!s || typeof s !== "string") return "";
  if (s.includes("/")) { const [m, d, y] = s.split("/"); return (m && d && y) ? `${pad2(m)}/${pad2(d)}/${y}` : s; }
  if (s.includes("-")) { const [y, m, d] = s.split("-"); return (y && m && d) ? `${pad2(m)}/${pad2(d)}/${y}` : s; }
  return s;
}
function civilNum(s) { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(toMDY(s)); return m ? (+m[3]) * 10000 + (+m[1]) * 100 + (+m[2]) : 0; }
function mdyToUTC(s) { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(toMDY(s)); return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : null; }
function daysBetween(aMDY, bMDY) { const a = mdyToUTC(aMDY), b = mdyToUTC(bMDY); return (a == null || b == null) ? 0 : Math.round((b - a) / 86400000); }
export function etNow() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const wk = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { mdy: `${p.month}/${p.day}/${p.year}`, hour: (+p.hour) % 24, weekday: wk[p.weekday], day: +p.day, ym: `${p.year}-${p.month}` };
}
export function etDateMinus(days) {
  const [m, d, y] = etNow().mdy.split("/").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d)); base.setUTCDate(base.getUTCDate() - days);
  return `${pad2(base.getUTCMonth() + 1)}/${pad2(base.getUTCDate())}/${base.getUTCFullYear()}`;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function prevMonthRange(todayMDY) {
  const [m, , y] = todayMDY.split("/").map(Number);
  const lastPrev = new Date(Date.UTC(y, m - 1, 1) - 86400000);
  const lm = lastPrev.getUTCMonth(), ly = lastPrev.getUTCFullYear();
  const first = new Date(Date.UTC(ly, lm, 1));
  const fmt = (dt) => `${pad2(dt.getUTCMonth() + 1)}/${pad2(dt.getUTCDate())}/${dt.getUTCFullYear()}`;
  return { start: fmt(first), end: fmt(lastPrev), label: `${MONTHS[lm]} ${ly}` };
}

// ── invoice math (compact port of App.jsx invoiceTotals/effectiveStatus) ─────────────────────────
const num = (v) => parseFloat(v) || 0;
function invTotal(iv) {
  if (iv.source === "quickbooks" && iv.total != null && iv.locallyEdited !== true) return num(iv.total);
  const items = iv.lineItems || [];
  const lineNet = (li) => { const g = num(li.qty) * num(li.unitPrice); let d = 0; if (li.discountType === "pct") d = g * (num(li.discount) / 100); else if (li.discountType === "amt") d = num(li.discount); return Math.max(0, g - d); };
  const subAfterLine = items.reduce((s, li) => s + lineNet(li), 0);
  let invDisc = 0; if (iv.discountType === "pct") invDisc = subAfterLine * (num(iv.discount) / 100); else if (iv.discountType === "amt") invDisc = num(iv.discount); invDisc = Math.min(invDisc, subAfterLine);
  const subtotal = subAfterLine - invDisc;
  const taxableAfterLine = items.reduce((s, li) => s + (li.taxable ? lineNet(li) : 0), 0);
  const f = subAfterLine > 0 ? (1 - invDisc / subAfterLine) : 1;
  return subtotal + taxableAfterLine * f * (num(iv.taxRate) / 100);
}
const invBalance = (iv) => (iv.balance != null ? num(iv.balance) : invTotal(iv));
function effStatus(iv, todayNum) {
  if (iv.status === "Sent" && iv.dueDate) { const due = civilNum(iv.dueDate); if (due && due < todayNum) return "Overdue"; }
  return iv.status;
}
const money = (n) => "$" + (Math.round(num(n) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n) => "$" + Math.round(num(n)).toLocaleString("en-US");
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── build the report data for a given interval ──────────────────────────────────────────────────
export function buildDigest(state, { period }) {
  const P = period === "monthly" ? "monthly" : period === "weekly" ? "weekly" : "daily";
  const invoices = Array.isArray(state.invoices) ? state.invoices : [];
  const clients = Array.isArray(state.clients) ? state.clients : [];
  const schedule = Array.isArray(state.schedule) ? state.schedule : [];
  const todayMDY = etNow().mdy;
  const todayNum = civilNum(todayMDY);
  const [tm, , ty] = todayMDY.split("/").map(Number);
  const yest = etDateMinus(1);

  let winStartMDY, winEndMDY, periodLabel, kind, pill, collectedLabel, doneTitle, tallyLabel, tallyStartNum, tallyEndNum;
  if (P === "monthly") {
    const r = prevMonthRange(todayMDY);
    winStartMDY = r.start; winEndMDY = r.end; periodLabel = r.label; kind = "Monthly"; pill = r.label.split(" ")[0].slice(0, 3).toUpperCase();
    collectedLabel = "Collected"; doneTitle = `Work done · ${r.label}`;
    // YTD is anchored to the REPORTED month's year (so a December report sent in January reports the
    // prior full year, not an empty current-year range).
    const winYr = +r.end.split("/")[2];
    tallyLabel = `Year to date · ${winYr}`; tallyStartNum = winYr * 10000 + 101; tallyEndNum = civilNum(r.end);
  } else if (P === "weekly") {
    winStartMDY = etDateMinus(7); winEndMDY = yest; periodLabel = `${winStartMDY} – ${winEndMDY}`; kind = "Weekly"; pill = "WEEK";
    collectedLabel = "Collected (7 days)"; doneTitle = "Work done this week";
    tallyLabel = `This month · ${MONTHS[tm - 1] || ""}`; tallyStartNum = ty * 10000 + tm * 100 + 1; tallyEndNum = todayNum;
  } else {
    winStartMDY = yest; winEndMDY = yest; periodLabel = yest; kind = "Daily"; pill = "TODAY";
    collectedLabel = "Collected"; doneTitle = "Done yesterday";
    tallyLabel = `This month · ${MONTHS[tm - 1] || ""}`; tallyStartNum = ty * 10000 + tm * 100 + 1; tallyEndNum = todayNum;
  }
  const winStartNum = civilNum(winStartMDY), winEndNum = civilNum(winEndMDY);
  const inWindow = (ds) => { const n = civilNum(ds); return n >= winStartNum && n <= winEndNum; };
  const nameOf = (id) => (clients.find((c) => String(c.id) === String(id)) || {}).name || "Client";

  // Outstanding invoices (money still owed) — as of now, overdue first — + A/R aging
  const outstanding = invoices
    .map((iv) => ({ iv, st: effStatus(iv, todayNum) }))
    .filter((x) => x.st !== "Paid" && x.st !== "Draft" && invBalance(x.iv) > 0.005)
    .map((x) => ({ number: x.iv.number || x.iv.id || "", client: x.iv.clientName || nameOf(x.iv.clientId), amount: invBalance(x.iv), due: toMDY(x.iv.dueDate), overdue: x.st === "Overdue" }))
    .sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || (b.amount - a.amount));
  const outstandingTotal = outstanding.reduce((s, o) => s + o.amount, 0);
  const overdue = outstanding.filter((o) => o.overdue);
  const overdueTotal = overdue.reduce((s, o) => s + o.amount, 0);
  const aging = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
  outstanding.forEach((o) => {
    const dpd = o.due ? daysBetween(o.due, todayMDY) : 0;
    if (dpd <= 0) aging.current += o.amount; else if (dpd <= 30) aging.d30 += o.amount; else if (dpd <= 60) aging.d60 += o.amount; else if (dpd <= 90) aging.d90 += o.amount; else aging.d90p += o.amount;
  });

  // Payments (window) + a range aggregator reused for MTD/YTD tallies
  // Collection date: mirror the app (monthActuals/dashboard use `iv.paidDate || iv.date`), so a Paid
  // invoice without an explicit paidDate (e.g. QuickBooks-synced) still counts on its txn date.
  const paidWhen = (iv) => iv.paidDate || iv.date;
  const paidInv = invoices.filter((iv) => effStatus(iv, todayNum) === "Paid" && paidWhen(iv));
  const rangeAgg = (a, b) => {
    let rev = 0, prof = 0, jobs = 0;
    clients.forEach((c) => (c.history || []).forEach((h) => { const n = civilNum(h && h.date); if (n >= a && n <= b) { rev += num(String(h.invoice || "").replace(/[^0-9.]/g, "")) || num(h.breakdown && h.breakdown.revenue); prof += num(h.breakdown && h.breakdown.profit); jobs += 1; } }));
    const collected = paidInv.filter((iv) => { const n = civilNum(paidWhen(iv)); return n >= a && n <= b; }).reduce((s, iv) => s + invTotal(iv), 0);
    return { rev, prof, jobs, collected };
  };

  // What got done in the window (completed stops from client history)
  const done = [];
  let revenueDone = 0, profitDone = 0;
  clients.forEach((c) => (c.history || []).forEach((h) => {
    if (!h || !inWindow(h.date)) return;
    const rev = num(String(h.invoice || "").replace(/[^0-9.]/g, "")) || num(h.breakdown && h.breakdown.revenue);
    const prof = num(h.breakdown && h.breakdown.profit);
    revenueDone += rev; profitDone += prof;
    done.push({ date: toMDY(h.date), client: c.name || "Client", type: h.type || "Service", tech: h.tech || "", notes: h.notes || "", office: h.officeNotes || "", revenue: rev, profit: prof });
  }));
  done.sort((a, b) => civilNum(a.date) - civilNum(b.date) || String(a.client).localeCompare(String(b.client)));
  const jobs = done.length;
  const avgTicket = jobs ? revenueDone / jobs : 0;
  const marginPct = revenueDone > 0 ? Math.round((profitDone / revenueDone) * 100) : 0;

  // Per-tech breakdown (window)
  const byTech = {};
  done.forEach((d) => { const t = d.tech || "Unassigned"; (byTech[t] = byTech[t] || { jobs: 0, rev: 0, prof: 0 }); byTech[t].jobs++; byTech[t].rev += d.revenue; byTech[t].prof += d.profit; });
  const techRows = Object.entries(byTech).map(([tech, v]) => ({ tech, jobs: v.jobs, rev: v.rev, prof: v.prof })).sort((a, b) => b.rev - a.rev);

  const payments = paidInv.filter((iv) => inWindow(paidWhen(iv)))
    .map((iv) => ({ number: iv.number || iv.id || "", client: iv.clientName || nameOf(iv.clientId), amount: invTotal(iv), date: toMDY(paidWhen(iv)) }))
    .sort((a, b) => b.amount - a.amount);
  const paymentsTotal = payments.reduce((s, p) => s + p.amount, 0);

  const tally = { label: tallyLabel, ...rangeAgg(tallyStartNum, tallyEndNum) };

  const day = schedule.find((d) => d && toMDY(d.date) === toMDY(todayMDY));
  const agenda = ((day && day.stops) || []).map((s) => ({ time: s.time || "Any time", client: s.client || nameOf(s.id), type: s.type || "Service", address: s.address || "" }));

  return {
    period: P, periodLabel, kind, pill, collectedLabel, doneTitle, winStartMDY, winEndMDY, yest,
    outstanding, outstandingTotal, overdue, overdueTotal, aging,
    done, revenueDone, profitDone, jobs, avgTicket, marginPct, techRows,
    payments, paymentsTotal, tally, agenda,
  };
}

// ── render the branded HTML email ─────────────────────────────────────────────────────────────────
export function renderEmail(dg, branding) {
  const accent = /^#?[0-9a-fA-F]{3,8}$/.test(branding.accent || "") ? branding.accent : "#B81D24";
  const company = esc(branding.companyName || "Stone Property Solutions");
  const logo = branding.logoSrc || DEFAULT_LOGO;
  const g = "#16a34a", grayT = "#6b7280", faint = "#9ca3af", ink = "#111827", line = "#eef0f2";

  const card = (title, inner, right) => `<div style="border:1px solid ${line};border-radius:14px;margin-top:14px;overflow:hidden">
    <div style="background:#f8f9fb;padding:11px 16px;border-bottom:1px solid ${line};display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:13px;font-weight:800;color:${ink}">${title}</span>${right ? `<span style="font-size:12px;font-weight:700;color:${grayT}">${right}</span>` : ""}</div>
    <div style="padding:14px 16px">${inner}</div></div>`;
  const muted = (t) => `<div style="font-size:13px;color:${faint}">${t}</div>`;
  const metric = (label, value, color, sub) => `<td width="50%" style="padding:5px;vertical-align:top">
    <div style="background:#f8f9fb;border-radius:12px;padding:12px 15px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:${faint};white-space:nowrap">${label}</div>
      <div style="font-size:23px;font-weight:800;color:${color || ink};margin-top:3px;line-height:1.1;white-space:nowrap">${value}</div>
      ${sub ? `<div style="font-size:11.5px;color:${faint};margin-top:2px;white-space:nowrap">${sub}</div>` : ""}
    </div></td>`;

  const snapshot = `<table style="width:100%;border-collapse:collapse;table-layout:fixed">
    <tr>${metric("Collected", money0(dg.paymentsTotal), g, `${dg.payments.length} payment${dg.payments.length === 1 ? "" : "s"}`)}
        ${metric("Outstanding", money0(dg.outstandingTotal), ink, `${dg.outstanding.length} invoice${dg.outstanding.length === 1 ? "" : "s"}`)}</tr>
    <tr>${metric("Overdue", money0(dg.overdueTotal), dg.overdueTotal > 0 ? accent : ink, `${dg.overdue.length} past due`)}
        ${metric("Work done", money0(dg.revenueDone), ink, `${dg.jobs} stop${dg.jobs === 1 ? "" : "s"}`)}</tr>
    <tr>${metric("Est. profit", money0(dg.profitDone), dg.profitDone >= 0 ? g : accent, `${dg.marginPct}% margin`)}
        ${metric("Avg / job", money0(dg.avgTicket), ink, "per stop")}</tr>
  </table>`;

  const mCell = (label, value, color) => `<td width="25%" style="text-align:center;vertical-align:top;padding:0 3px">
    <div style="font-size:17px;font-weight:800;color:${color || ink};line-height:1.1;white-space:nowrap">${value}</div>
    <div style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:${faint};margin-top:3px;white-space:nowrap">${label}</div></td>`;
  const tallyCard = `<div style="border:1.5px solid ${accent};border-radius:14px;margin-top:14px;overflow:hidden">
    <div style="background:${accent};padding:9px 16px;color:#fff;font-size:12px;font-weight:800;letter-spacing:.03em">${esc(dg.tally.label)}</div>
    <div style="padding:14px 6px"><table style="width:100%;border-collapse:collapse;table-layout:fixed"><tr>
      ${mCell("Collected", money0(dg.tally.collected), g)}${mCell("Billed", money0(dg.tally.rev), ink)}${mCell("Profit", money0(dg.tally.prof), dg.tally.prof >= 0 ? g : accent)}${mCell("Jobs", String(dg.tally.jobs), ink)}
    </tr></table></div></div>`;

  const agingCells = [["Current", dg.aging.current, ink], ["1–30", dg.aging.d30, ink], ["31–60", dg.aging.d60, "#b45309"], ["61–90", dg.aging.d90, accent], ["90+", dg.aging.d90p, accent]];
  const agingCard = dg.outstandingTotal > 0 ? card("Receivables aging", `<table style="width:100%;border-collapse:collapse;table-layout:fixed"><tr>${agingCells.map(([l]) => `<td style="text-align:center;font-size:10.5px;font-weight:700;text-transform:uppercase;color:${faint};padding-bottom:4px">${l}</td>`).join("")}</tr><tr>${agingCells.map(([, v, c]) => `<td style="text-align:center;font-size:14px;font-weight:800;color:${v > 0 ? c : faint}">${v > 0 ? money0(v) : "—"}</td>`).join("")}</tr></table>`) : "";

  const techCard = (dg.techRows.length && dg.jobs > 0 && (dg.techRows.length > 1 || dg.period !== "daily"))
    ? card("By tech", `<table style="width:100%;border-collapse:collapse">${dg.techRows.map((t) => `<tr><td style="padding:5px 0;font-size:13px;color:${ink};font-weight:700">${esc(t.tech)}</td><td style="padding:5px 0;font-size:12.5px;color:${faint};text-align:right">${t.jobs} stop${t.jobs === 1 ? "" : "s"}</td><td style="padding:5px 0 5px 14px;font-size:13px;color:${ink};font-weight:800;text-align:right;white-space:nowrap">${money0(t.rev)}</td></tr>`).join("")}</table>`) : "";

  const owedRows = dg.outstanding.slice(0, 12).map((o) => `<tr>
      <td style="padding:6px 0;font-size:13px;color:${ink}">${esc(o.client)} <span style="color:${faint}">· ${esc(String(o.number))}</span>${o.overdue ? ` <span style="color:${accent};font-weight:800">OVERDUE</span>` : ""}${o.due ? ` <span style="color:${faint}">· due ${esc(o.due)}</span>` : ""}</td>
      <td style="padding:6px 0;font-size:13px;color:${ink};font-weight:800;text-align:right;white-space:nowrap">${money(o.amount)}</td></tr>`).join("");
  const owedCard = dg.outstanding.length ? card("Invoices still owed", `<table style="width:100%;border-collapse:collapse">${owedRows}</table>${dg.outstanding.length > 12 ? muted(`+ ${dg.outstanding.length - 12} more`) : ""}`, money(dg.outstandingTotal)) : card("Invoices still owed", muted("Nothing outstanding — you're all paid up. 🎉"));

  const shown = dg.done.slice(0, 15);
  const doneRows = shown.map((d) => `<div style="padding:9px 0;border-top:1px solid #f1f2f4">
      <table style="width:100%;border-collapse:collapse"><tr>
        <td style="font-size:13px;color:${ink}"><b>${esc(d.client)}</b> <span style="color:${faint}">· ${esc(d.type)}${d.tech ? ` · ${esc(d.tech)}` : ""}${dg.period !== "daily" ? ` · ${esc(d.date)}` : ""}</span></td>
        <td style="text-align:right;white-space:nowrap">${d.revenue > 0 ? `<span style="color:${g};font-weight:800;font-size:13px">${money(d.revenue)}</span>` : ""}</td></tr></table>
      ${d.notes ? `<div style="font-size:12.5px;color:#4b5563;margin-top:2px">${esc(d.notes)}</div>` : ""}
      ${d.office ? `<div style="font-size:12px;color:${faint};margin-top:2px">Office: ${esc(d.office)}</div>` : ""}</div>`).join("");
  const doneCard = card(dg.doneTitle, dg.done.length ? doneRows + (dg.done.length > 15 ? muted(`+ ${dg.done.length - 15} more stops`) : "") : muted(dg.period === "daily" ? "No stops were completed yesterday." : "No completed stops in this period."), `${dg.jobs} stop${dg.jobs === 1 ? "" : "s"}${dg.revenueDone > 0 ? ` · ${money(dg.revenueDone)}` : ""}`);

  const payCard = dg.payments.length ? card("Payments received", `<table style="width:100%;border-collapse:collapse">${dg.payments.slice(0, 20).map((p) => `<tr><td style="padding:5px 0;font-size:13px;color:${ink}">${esc(p.client)} <span style="color:${faint}">· ${esc(String(p.number))}${dg.period !== "daily" ? ` · ${esc(p.date)}` : ""}</span></td><td style="padding:5px 0;font-size:13px;font-weight:800;color:${g};text-align:right">${money(p.amount)}</td></tr>`).join("")}${dg.payments.length > 20 ? muted(`+ ${dg.payments.length - 20} more`) : ""}</table>`, money(dg.paymentsTotal)) : "";

  const agRows = dg.agenda.map((a) => `<tr>
      <td style="padding:6px 10px 6px 0;font-size:13px;color:${accent};white-space:nowrap;vertical-align:top;font-weight:800">${esc(a.time)}</td>
      <td style="padding:6px 0;font-size:13px;color:${ink}">${esc(a.client)} <span style="color:${faint}">· ${esc(a.type)}</span>${a.address ? `<div style="font-size:12px;color:${faint}">${esc(a.address)}</div>` : ""}</td></tr>`).join("");
  const agendaCard = card("On today's agenda", dg.agenda.length ? `<table style="width:100%;border-collapse:collapse">${agRows}</table>` : muted("Nothing scheduled for today."), `${dg.agenda.length} stop${dg.agenda.length === 1 ? "" : "s"}`);

  const contact = [branding.companyPhone, branding.companyEmail, branding.companyAddress].filter(Boolean).map(esc).join(" &nbsp;·&nbsp; ");

  return `<div style="background:#f4f5f7;padding:20px 12px">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e6e8ec;border-radius:18px;overflow:hidden">
    <div style="padding:20px 20px 16px;border-bottom:3px solid ${accent}">
      <table style="width:100%;border-collapse:collapse"><tr>
        <td style="width:46px;vertical-align:middle"><img src="${esc(logo)}" width="46" height="46" alt="${company}" style="width:46px;height:46px;border-radius:12px;display:block;object-fit:cover" /></td>
        <td style="padding-left:13px;vertical-align:middle">
          <div style="font-size:18px;font-weight:800;color:${ink};letter-spacing:-0.02em">${company}</div>
          <div style="font-size:12.5px;color:${grayT};margin-top:2px">${esc(dg.kind)} report &nbsp;·&nbsp; ${esc(dg.periodLabel)}</div>
        </td>
        <td style="text-align:right;vertical-align:middle;white-space:nowrap"><div style="display:inline-block;background:${accent};color:#fff;font-size:11px;font-weight:800;padding:5px 11px;border-radius:100px">${esc(dg.pill)}</div></td>
      </tr></table>
    </div>
    <div style="padding:8px 16px 20px">
      <div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:${faint};margin:12px 4px 2px">Financial snapshot</div>
      ${snapshot}
      ${tallyCard}${agingCard}${techCard}${owedCard}${doneCard}${payCard}${agendaCard}
      ${contact ? `<div style="text-align:center;font-size:11px;color:${faint};margin-top:18px;line-height:1.6">${company}<br>${contact}</div>` : ""}
    </div>
  </div></div>`;
}

export function renderText(dg) {
  const L = [`${dg.kind.toUpperCase()} REPORT · ${dg.periodLabel}`, ""];
  L.push(`Collected: ${money(dg.paymentsTotal)} · Outstanding: ${money(dg.outstandingTotal)} (${money(dg.overdueTotal)} overdue)`);
  L.push(`Work done: ${money(dg.revenueDone)} (${dg.jobs} stops) · Est. profit: ${money(dg.profitDone)} (${dg.marginPct}%)`);
  L.push(`${dg.tally.label}: collected ${money(dg.tally.collected)} · billed ${money(dg.tally.rev)} · profit ${money(dg.tally.prof)} · ${dg.tally.jobs} jobs`, "");
  L.push("INVOICES STILL OWED"); dg.outstanding.slice(0, 25).forEach((o) => L.push(`  - ${o.client} #${o.number} ${money(o.amount)}${o.overdue ? " OVERDUE" : ""}${o.due ? ` (due ${o.due})` : ""}`));
  L.push("", `${dg.doneTitle.toUpperCase()} (${dg.jobs} stops, ${money(dg.revenueDone)})`);
  dg.done.slice(0, 40).forEach((d) => L.push(`  - ${d.client} · ${d.type}${d.revenue > 0 ? ` ${money(d.revenue)}` : ""}${d.notes ? ` — ${d.notes}` : ""}`));
  if (dg.payments.length) { L.push("", `PAYMENTS RECEIVED (${money(dg.paymentsTotal)})`); dg.payments.slice(0, 40).forEach((p) => L.push(`  - ${p.client} #${p.number} ${money(p.amount)}`)); }
  L.push("", `TODAY'S AGENDA (${dg.agenda.length} stops)`); dg.agenda.forEach((a) => L.push(`  - ${a.time} ${a.client} · ${a.type}`));
  return L.join("\n");
}

function resolveLogo(branding) {
  const img = branding && branding.logoImage;
  if (typeof img === "string") {
    const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(img);
    if (m) return { logoSrc: "cid:logo@sps", attachments: [{ filename: "logo." + (m[1].split("/")[1] || "png").replace("jpeg", "jpg"), content: m[2], content_type: m[1], content_id: "logo@sps" }] };
    if (/^https?:\/\//.test(img)) return { logoSrc: img, attachments: [] };
  }
  return { logoSrc: DEFAULT_LOGO, attachments: [] };
}

async function sendDigest({ period, state, cfg, email, branding }) {
  const to = String((cfg.ownerDigest && cfg.ownerDigest.to) || email.ownerEmail || branding.companyEmail || "").trim();
  if (!to || !/.+@.+\..+/.test(to)) return { sent: false, skipped: "no recipient email (set an Owner Digest recipient, or a company email)" };
  if (!RESEND_KEY) return { sent: false, skipped: "RESEND_API_KEY not set" };
  const dg = buildDigest(state, { period });
  const { logoSrc, attachments } = resolveLogo(branding);
  const from = resolveFrom({ fromName: email.fromName, fromAddress: email.fromAddress }, process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>");
  const subject = `${branding.companyName || "SPS"} — ${dg.kind} report · ${dg.periodLabel}`;
  let r;
  try {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html: renderEmail(dg, { ...branding, logoSrc }), text: renderText(dg), ...(attachments.length ? { attachments } : {}) }),
    });
  } catch (e) { return { sent: false, error: `network: ${(e && ((e.cause && e.cause.code) || e.message)) || "fetch failed"}` }; }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { sent: false, error: d?.message || `Resend ${r.status}` };
  return { sent: true, to, id: d.id || null, period };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};
  const dryRun = q.dryRun === "1" || q.dry === "1";
  const test = q.test === "1";
  const html = q.html === "1"; // rendered HTML for in-app preview / print-to-PDF
  const period = ["daily", "weekly", "monthly"].includes(q.period) ? q.period : "daily";

  const [cfg, email, clients, schedule, invoices, branding, team] = await Promise.all([
    sbGet("sps_schedule_cfg", {}), sbGet("sps_email", {}), sbGet("sps_clients", []),
    sbGet("sps_schedule", []), sbGet("sps_invoices", []), sbGet("sps_branding", {}), sbGet("sps_team", []),
  ]);
  const state = { clients, schedule, invoices, branding };
  const od = cfg.ownerDigest || {};

  // test + dryRun expose / trigger the owner's financials → OWNER ONLY (verify by email, independent
  // of API_AUTH_ENFORCED). Real cron runs use CRON_SECRET instead.
  if (dryRun || test || html) {
    const ownerEmails = [((team || []).find((m) => m && m.role === "owner") || {}).email, branding.companyEmail, email.ownerEmail, od.to].filter(Boolean).map((e) => String(e).toLowerCase());
    const u = await verifyUser(req);
    const callerEmail = (u && u.email || "").toLowerCase();
    // Fail closed: also deny when no owner identity can be established (empty ownerEmails), so a
    // signed-in staff member or client can't pull financials before the owner sets an email.
    if (!callerEmail || ownerEmails.length === 0 || !ownerEmails.includes(callerEmail)) return res.status(403).json({ error: "Owner only. Set a company or owner email in settings first." });
  } else {
    const cronOk = !!CRON_SECRET && req.headers.authorization === `Bearer ${CRON_SECRET}`;
    if (!cronOk) return res.status(401).json({ error: "unauthorized", hint: "real runs require CRON_SECRET; use ?test=1 (signed in as owner) to send yourself one now" });
  }

  if (dryRun) return res.status(200).json({ ok: true, dryRun: true, daily: buildDigest(state, { period: "daily" }), weekly: buildDigest(state, { period: "weekly" }), monthly: buildDigest(state, { period: "monthly" }) });
  if (html) {
    // Browser-viewable version for preview + print-to-PDF. Use the logo as a data/http URL (cid is
    // email-only). Wrapped in a minimal page with a print button that auto-opens the print dialog.
    const logoSrc = (typeof branding.logoImage === "string" && (branding.logoImage.startsWith("data:") || /^https?:\/\//.test(branding.logoImage))) ? branding.logoImage : DEFAULT_LOGO;
    const body = renderEmail(buildDigest(state, { period }), { ...branding, logoSrc });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(branding.companyName || "SPS")} report</title><style>@media print{.noprint{display:none}}</style></head><body style="margin:0;background:#f4f5f7">${body}<div class="noprint" style="text-align:center;padding:14px"><button onclick="window.print()" style="background:${/^#?[0-9a-fA-F]{3,8}$/.test(branding.accent||"")?branding.accent:"#B81D24"};color:#fff;border:none;border-radius:10px;padding:11px 22px;font-size:15px;font-weight:800;cursor:pointer;font-family:-apple-system,sans-serif">Print / Save as PDF</button></div></body></html>`);
  }
  if (test) { const out = await sendDigest({ period, state, cfg, email, branding }); return res.status(out.sent ? 200 : 400).json({ ok: out.sent, test: true, ...out }); }

  // ── real cron run ──
  if (!od.dailyOn && !od.weeklyOn && !od.monthlyOn) return res.status(200).json({ ok: true, note: "Owner report is off." });
  const et = etNow();
  const sendHour = Number.isInteger(od.hour) ? od.hour : 7;
  // Lower-bound gate (not exact equality): a delayed/dropped top-of-hour cron run self-heals on a later
  // hourly run the same day, and the per-period ledger below still prevents any double-send.
  if (et.hour < sendHour) return res.status(200).json({ ok: true, note: `before the send hour (ET ${et.hour}:00, configured ${sendHour}:00)` });

  const ledger = await sbGet("sps_digest_log", {});
  const results = {};
  let changed = false;
  if (od.dailyOn && ledger.dailySent !== et.mdy) { results.daily = await sendDigest({ period: "daily", state, cfg, email, branding }); if (results.daily.sent) { ledger.dailySent = et.mdy; changed = true; } }
  const weeklyDay = Number.isInteger(od.weekday) ? od.weekday : 1;
  if (od.weeklyOn && et.weekday === weeklyDay && ledger.weeklySent !== et.mdy) { results.weekly = await sendDigest({ period: "weekly", state, cfg, email, branding }); if (results.weekly.sent) { ledger.weeklySent = et.mdy; changed = true; } }
  const monthDay = Number.isInteger(od.monthDay) ? od.monthDay : 1;
  const lastDom = new Date(Date.UTC(+et.ym.slice(0, 4), +et.ym.slice(5, 7), 0)).getUTCDate(); // clamp so 29/30/31 still fires in short months
  if (od.monthlyOn && et.day === Math.min(monthDay, lastDom) && ledger.monthlySent !== et.ym) { results.monthly = await sendDigest({ period: "monthly", state, cfg, email, branding }); if (results.monthly.sent) { ledger.monthlySent = et.ym; changed = true; } }
  if (changed) await sbSet("sps_digest_log", ledger);

  // Push mirror of whatever emailed — best-effort, and deliberately NOT part of the ledger
  // decision above (a push-only success must never suppress the email retry).
  for (const period of ["daily", "weekly", "monthly"]) {
    if (results[period] && results[period].sent) {
      results[period].push = await pushOwner("reports", `Your ${period} report is out`,
        "The business digest just landed in your inbox — tap for the live numbers.", "reports",
        { email, collapseId: `digest-${period}` });
    }
  }

  return res.status(200).json({ ok: true, ran: new Date().toISOString(), et, results });
}
