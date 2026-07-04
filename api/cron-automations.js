// api/cron-automations.js
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The auto-send engine. A Vercel cron hits this on a schedule; it reads the app's data with the
// service-role key, figures out which automated client messages are DUE right now, and sends them
// through Quo from the business number — appointment + seasonal reminders, payment nudges, win-back.
//
// SAFETY (six independent layers — any one stops a bad send):
//   1. MASTER SWITCH    — does nothing unless sps_schedule_cfg.schedulerOn === true.
//   2. TEST MODE        — sps_email.testMode: redirects every message to the owner ([TEST → num])
//                         or holds it. So the first live runs reach the OWNER, not clients.
//   3. DRY RUN          — ?dryRun=1 returns the exact would-send list and sends nothing (the app's
//                         "Preview what would send" button). Dry runs require an owner token; real
//                         runs require the Vercel CRON_SECRET — the app can never trigger a real send.
//   4. NEVER-TWICE      — a dedup ledger (sps_reminders for appt/seasonal, sps_auto_log for the rest)
//                         keyed per-message, PLUS a per-client/per-type cooldown (autoCooldownHours).
//   5. OPT-OUTS         — every send re-checks the client's per-type opt-out + their text channel.
//   6. RUNAWAY CAP      — at most RATE_CAP sends per run; anything beyond is reported, not sent.
//
// Env (Vercel): SUPABASE_SERVICE_ROLE_KEY, QUO_API_KEY, QUO_PHONE_NUMBER, CRON_SECRET. Optional SUPABASE_URL.

import { requireUser } from "./_auth.js";
import { pushOwner } from "./_push.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUO_KEY      = process.env.QUO_API_KEY;
const QUO_FROM     = process.env.QUO_PHONE_NUMBER;
const CRON_SECRET  = process.env.CRON_SECRET;
const RATE_CAP     = 60; // hard ceiling on real sends per run

// Fallback templates — mirror DEFAULT_EMAIL in App.jsx; the owner's edits in sps_email win.
const T = {
  smsReminder:     "Hi {first}, a friendly reminder from {company} that your service is scheduled for {date}. Reply here with any questions!",
  smsPaymentNudge: "Hi {first}, a friendly reminder from {company}: invoice {number} for {amount} is past due. You can take care of it here: {link}. Thank you!",
  smsWinBack:      "Hi {first}, we've missed taking care of your {service}! It's been a little while — just reply here and we'll get you right back on the {company} schedule.",
};
const SERVICE_WORD = { Pond: "pond", Pool: "pool", Seasonal: "seasonal service" };

// ── Supabase (service-role REST) ────────────────────────────────────────────────────────────────
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
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value: JSON.stringify(obj) }]),
  });
}
async function logComm(clientId, type, body, ok, origin = "", recipient = "") {
  if (clientId == null) return;
  const base = { client_id: String(clientId), type, channel: "sms", body: String(body || "").slice(0, 800), ok: !!ok };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, {
      method: "POST", headers: sbHeaders(),
      body: JSON.stringify({ ...base, origin: String(origin).slice(0, 140), recipient: String(recipient).slice(0, 140) }),
    });
    // Legacy-shape fallback ONLY for the missing-column case (fresh installs that haven't run
    // the ALTER TABLE) — never on transient errors, which would silently strip the origin.
    if (r.status === 400 && /column/i.test(await r.text().catch(() => ""))) {
      await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, { method: "POST", headers: sbHeaders(), body: JSON.stringify(base) });
    }
  } catch { /* best-effort */ }
}

// ── small helpers ───────────────────────────────────────────────────────────────────────────────
function toE164(s) {
  const raw = String(s == null ? "" : s).trim();
  if (raw.startsWith("+")) return "+" + raw.slice(1).replace(/\D/g, "");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d ? "+" + d : "";
}
const fill = (tpl, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v == null ? "" : String(v)), String(tpl || ""));
const firstName = (name) => (String(name || "").trim().split(/\s+/)[0] || "there");
const money = (n) => "$" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const dayMs = 86400000;
function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  let y, m, d;
  if (str.includes("/")) { const [mm, dd, yy] = str.split("/").map(Number); m = mm; d = dd; y = yy; }
  else if (str.includes("-")) { const [yy, mm, dd] = str.split("-").map(Number); y = yy; m = mm; d = dd; }
  else return null;
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
const isActive = (c) => (c.status || "Active") !== "Inactive";
const textOn   = (c) => !(c.notifyPrefs && c.notifyPrefs.channels && c.notifyPrefs.channels.text === false);
const optedOut = (c, key) => !!(c.notifyPrefs && c.notifyPrefs[key] === false);
function invTotal(inv) {
  if (inv.total != null && inv.total !== "") return Number(inv.total) || 0;
  const items = Array.isArray(inv.lineItems) ? inv.lineItems : [];
  const sub = items.reduce((s, li) => s + (Number(li.qty) || 0) * (Number(li.unitPrice) || 0), 0);
  const rate = Number(inv.taxRate) || 0;
  const taxed = items.reduce((s, li) => s + (li.taxable !== false ? (Number(li.qty) || 0) * (Number(li.unitPrice) || 0) : 0), 0);
  return sub + (taxed * rate) / 100;
}
function invBalance(inv) {
  if (inv.balance != null && inv.balance !== "") return Number(inv.balance) || 0;
  return invTotal(inv) - (Number(inv.amountPaid) || 0);
}

// ── Quo send ──────────────────────────────────────────────────────────────────────────────────
async function sendQuo(to, from, message) {
  const toNum = toE164(to), fromNum = toE164(from) || toE164(QUO_FROM);
  if (!toNum) return { ok: false, error: "bad recipient number" };
  if (!fromNum) return { ok: false, error: "no business number" };
  try {
    const r = await fetch("https://api.quo.com/v1/messages", {
      method: "POST", headers: { Authorization: QUO_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(message), from: fromNum, to: [toNum] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data?.message || data?.error || `Quo ${r.status}` };
    return { ok: true, id: (data && (data.data?.id || data.id)) || null };
  } catch (e) { return { ok: false, error: e.message || "network" }; }
}

// ── due-message collectors (pure: build the list, no sends) ─────────────────────────────────────
function collectAppointments(now, schedule, clientsById, cfg, email, reminderLog) {
  const out = [];
  if (!cfg.remindersOn) return out;
  const tpl = email.smsReminder ?? T.smsReminder;
  const leadMs = (Number(cfg.reminderLeadHours) || 24) * 3600000;
  const [sh, sm] = String(cfg.reminderSendAt || "17:00").split(":").map(Number);
  for (const day of (schedule || [])) {
    for (const stop of (day.stops || [])) {
      const sid = stop.sid; if (!sid || reminderLog[sid]) continue;
      const base = parseDate(day.date); if (!base) continue;
      const stopDate = new Date(base);
      if (stop.time) { const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(stop.time); if (m) { let h = +m[1]; const mi = +m[2]; const ap = (m[3] || "").toLowerCase(); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; stopDate.setHours(h, mi, 0, 0); } else stopDate.setHours(9, 0, 0, 0); }
      else stopDate.setHours(9, 0, 0, 0);
      if (stopDate.getTime() < now) continue;
      let sendTime = new Date(stopDate.getTime() - leadMs);
      if (leadMs >= 12 * 3600000 && !isNaN(sh)) sendTime.setHours(sh, sm || 0, 0, 0);
      if (sendTime.getTime() > now) continue; // not due yet
      const c = clientsById[String(stop.id ?? stop.clientId)]; if (!c || !isActive(c) || optedOut(c, "serviceReminders") || !textOn(c) || !c.phone) continue;
      out.push({ type: "Reminder", dedup: { ledger: "rem", key: sid }, clientId: c.id, to: c.phone,
        message: fill(tpl, { first: firstName(c.name), company: cfg._company, date: day.date }), who: c.name });
    }
  }
  return out;
}
function collectSeasonal(now, clients, cfg, email, reminderLog) {
  const out = [];
  if (!cfg.remindersOn) return out;
  const year = new Date(now).getFullYear();
  const today = new Date(new Date(now).toDateString()).getTime();
  for (const r of (cfg.seasonalReminders || [])) {
    const trig = new Date(year, (Number(r.month) || 1) - 1, Number(r.day) || 1).getTime();
    const daysUntil = Math.round((trig - today) / dayMs);
    if (daysUntil > 14 || daysUntil < -3) continue;
    for (const c of clients) {
      if (!isActive(c) || optedOut(c, "serviceReminders") || !textOn(c) || !c.phone) continue;
      if (r.division && r.division !== "All" && (c.division || "Pond") !== r.division) continue;
      const key = `seas_${r.id}_${c.id}_${year}`; if (reminderLog[key]) continue;
      const msg = r.message || (email.smsReminder ?? T.smsReminder);
      out.push({ type: "Seasonal", dedup: { ledger: "rem", key }, clientId: c.id, to: c.phone,
        message: fill(msg, { first: firstName(c.name), company: cfg._company, date: `${r.month}/${r.day}` }), who: c.name });
    }
  }
  return out;
}
function collectPaymentNudges(now, invoices, clientsById, cfg, email, autoLog) {
  const out = [];
  if (!cfg.paymentNudgeOn) return out;
  const tpl = email.smsPaymentNudge ?? T.smsPaymentNudge;
  const after = Number(cfg.paymentNudgeAfterDays) || 3, repeat = Number(cfg.paymentNudgeRepeatDays) || 7, max = Number(cfg.paymentNudgeMax) || 3;
  const today = new Date(new Date(now).toDateString()).getTime();
  for (const inv of (invoices || [])) {
    if (!inv || inv.status === "Paid" || inv.status === "Draft" || inv.status === "Void") continue;
    if (invBalance(inv) <= 0) continue;
    const due = parseDate(inv.dueDate); if (!due || due.getTime() >= today) continue;
    const daysOverdue = Math.floor((today - due.getTime()) / dayMs);
    const rec = autoLog[`nudge_${inv.id}`] || { count: 0, lastSentAt: null };
    if (rec.count >= max) continue;
    const eligible = rec.count === 0 ? daysOverdue >= after : (now - new Date(rec.lastSentAt || 0).getTime()) >= repeat * dayMs;
    if (!eligible) continue;
    const c = clientsById[String(inv.clientId)]; if (!c || !isActive(c) || optedOut(c, "paymentNudges") || !textOn(c) || !c.phone) continue;
    const link = inv.paymentLink ? `Pay here: ${inv.paymentLink}` : "View & pay it in your portal: spsway.app";
    out.push({ type: "PaymentNudge", dedup: { ledger: "auto", key: `nudge_${inv.id}`, bump: rec }, clientId: c.id, to: c.phone, who: c.name,
      message: fill(tpl, { first: firstName(c.name), company: cfg._company, number: inv.number || "", amount: money(invBalance(inv)), dueDate: inv.dueDate || "", link }) });
  }
  return out;
}
function collectWinBack(now, clients, cfg, email, autoLog) {
  const out = [];
  if (!cfg.winBackOn) return out;
  const tpl = email.smsWinBack ?? T.smsWinBack;
  const lapseMs = (Number(cfg.winBackAfterDays) || 60) * dayMs;
  for (const c of clients) {
    if (!isActive(c) || optedOut(c, "winBack") || !textOn(c) || !c.phone) continue;
    const hist = Array.isArray(c.history) ? c.history : [];
    if (!hist.length) continue; // never serviced → not "lapsed"
    let lastMs = 0;
    for (const h of hist) { const d = parseDate(h.date); if (d && d.getTime() > lastMs) lastMs = d.getTime(); }
    if (!lastMs || (now - lastMs) < lapseMs) continue; // still recent
    const rec = autoLog[`winback_${c.id}`];
    if (rec && new Date(rec.sentAt || 0).getTime() >= lastMs) continue; // already nudged for this lapse
    out.push({ type: "WinBack", dedup: { ledger: "auto", key: `winback_${c.id}`, set: { sentAt: new Date(now).toISOString() } }, clientId: c.id, to: c.phone, who: c.name,
      message: fill(tpl, { first: firstName(c.name), company: cfg._company, service: SERVICE_WORD[c.division] || "service" }) });
  }
  return out;
}

// ── handler ─────────────────────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const dryRun = !!(req.query && (req.query.dryRun === "1" || req.query.dry === "1"));
  const cronOk = !!CRON_SECRET && req.headers.authorization === `Bearer ${CRON_SECRET}`;
  // Real (sending) runs require the Vercel cron secret — the app can never fire one. Dry runs (no
  // sends) just need a signed-in owner. If no CRON_SECRET is set yet, only dry runs are allowed.
  if (!dryRun && !cronOk) return res.status(401).json({ error: "unauthorized", hint: "real runs require CRON_SECRET; use ?dryRun=1 to preview" });
  if (dryRun) { const u = await requireUser(req, res); if (!u) return; }
  if (!SERVICE_KEY) return res.status(501).json({ error: "server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });

  const now = Date.now();
  const [cfg, email, clients, schedule, invoices, branding, reminderLog, autoLog] = await Promise.all([
    sbGet("sps_schedule_cfg", {}), sbGet("sps_email", {}), sbGet("sps_clients", []), sbGet("sps_schedule", []),
    sbGet("sps_invoices", []), sbGet("sps_branding", {}), sbGet("sps_reminders", {}), sbGet("sps_auto_log", {}),
  ]);

  if (!cfg.schedulerOn) return res.status(200).json({ ok: true, ran: new Date(now).toISOString(), master: false, note: "Automatic sending is off (master switch). Nothing sent." });

  cfg._company = (branding && branding.companyName) || "Stone Property Solutions";
  const clientsById = {}; (clients || []).forEach(c => { if (c && c.id != null) clientsById[String(c.id)] = c; });
  const testMode = (email && email.testMode) || { on: false };
  // Pilot launch: clients on the live list get REAL automated texts while Test Mode
  // holds/redirects everyone else. Stored as strings; compared as strings, always.
  const liveSet = new Set(((testMode.liveClientIds || [])).map(String));
  const isLive = (cid) => cid != null && liveSet.has(String(cid));
  const cooldownMs = (Number(cfg.autoCooldownHours) || 20) * 3600000;

  // 1) build the full due list
  let due = [
    ...collectAppointments(now, schedule, clientsById, cfg, email, reminderLog),
    ...collectSeasonal(now, clients, cfg, email, reminderLog),
    ...collectPaymentNudges(now, invoices, clientsById, cfg, email, autoLog),
    ...collectWinBack(now, clients, cfg, email, autoLog),
  ];

  // 2) cooldown: drop a message if this client already got the same type within the window
  const cooled = [];
  due = due.filter(m => {
    const ck = `cool_${m.type}_${m.clientId}`;
    const last = autoLog[ck] ? new Date(autoLog[ck]).getTime() : 0;
    if (now - last < cooldownMs) { cooled.push({ type: m.type, who: m.who }); return false; }
    return true;
  });

  // 3) runaway cap
  const capped = due.length > RATE_CAP ? due.slice(RATE_CAP) : [];
  const toSend = due.slice(0, RATE_CAP);

  // 4) DRY RUN — return the would-send list, change nothing
  if (dryRun) {
    return res.status(200).json({
      ok: true, dryRun: true, ran: new Date(now).toISOString(), master: true,
      testMode: { on: !!testMode.on, mode: testMode.mode || "redirect" },
      counts: { due: due.length, wouldSend: toSend.length, cooledDown: cooled.length, capped: capped.length },
      wouldSend: toSend.map(m => ({ type: m.type, to: testMode.on && isLive(m.clientId) ? `${m.to} (LIVE — pilot)` : testMode.on && testMode.mode === "redirect" ? `${testMode.phone} (TEST)` : m.to, client: m.who, message: m.message })),
      cooledDown: cooled, capped: capped.map(m => ({ type: m.type, client: m.who })),
    });
  }

  // 5) REAL RUN — send, then record dedup + cooldown + log
  let sent = 0; const errors = [];
  const remNext = { ...reminderLog }, autoNext = { ...autoLog };
  let sentReal = 0; // sends that actually reached a real client number (live pilots, or Test Mode off)
  for (const m of toSend) {
    let dest = m.to, body = m.message, held = false;
    const live = isLive(m.clientId);
    if (testMode.on && !live) {
      if (testMode.mode === "hold") { held = true; }
      else if (!testMode.phone) { errors.push({ who: m.who, error: "test mode on, no owner phone" }); continue; }
      else { dest = testMode.phone; body = `[TEST → ${m.to}] ${m.message}`; }
    }
    let ok = true;
    if (!held) {
      const r = await sendQuo(dest, (email && email.textingNumber) || "", body);
      ok = r.ok; if (!ok) errors.push({ who: m.who, error: r.error });
    }
    if (ok) {
      sent++;
      if (!held && (!testMode.on || live)) sentReal++;
      const stamp = new Date(now).toISOString();
      if (m.dedup.ledger === "rem") remNext[m.dedup.key] = { sentAt: stamp, method: "auto" };
      else if (m.dedup.key) { if (m.dedup.bump) autoNext[m.dedup.key] = { count: (m.dedup.bump.count || 0) + 1, lastSentAt: stamp }; else autoNext[m.dedup.key] = m.dedup.set || { sentAt: stamp }; }
      autoNext[`cool_${m.type}_${m.clientId}`] = stamp;
      // Honest accounting: a HELD send never happened — say so, and never stamp the real
      // client number as a delivered-to recipient. Pilot-live sends are labeled as such.
      await logComm(m.clientId, m.type, m.message, true,
        held ? `automation: ${m.type} (held by Test Mode)` : `automation: ${m.type}${testMode.on ? (live ? " · pilot (live)" : " · TEST redirect → you") : ""}`,
        held ? "" : dest);
    }
  }
  if (sent > 0 || errors.length) { await sbSet("sps_reminders", remNext); await sbSet("sps_auto_log", autoNext); }

  // ONE summary push per run (a full run can send up to RATE_CAP texts — never push per text).
  // Fires when anything ACTUALLY went out (real client sends — incl. pilot-live in a hold-mode
  // run — or redirected-to-owner sends); a fully-held run stays silent.
  if (sentReal > 0 || (sent > 0 && !(testMode.on && testMode.mode === "hold"))) {
    await pushOwner("reports", "Auto-texts sent",
      `${sent} automated ${sent === 1 ? "text" : "texts"} processed${sentReal ? ` · ${sentReal} to real clients` : ""}${errors.length ? ` · ${errors.length} failed` : ""}. Details in Comms.`,
      "comms", { email, collapseId: "auto-texts" });
  }

  return res.status(200).json({
    ok: true, ran: new Date(now).toISOString(), master: true,
    testMode: { on: !!testMode.on, mode: testMode.mode || "redirect" },
    counts: { due: due.length, sent, errors: errors.length, cooledDown: cooled.length, capped: capped.length },
    errors, capped: capped.map(m => ({ type: m.type, client: m.who })),
  });
}
