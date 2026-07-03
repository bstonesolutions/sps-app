// api/ai-debt-advisor.js
// AI payoff strategy for the Budget → Debt section. Takes the owner's debts (balance, APR, min
// payment, current payment, optional loan length), cash on hand, and REAL monthly cash flow (from
// the bank when connected), and returns short, dollar-specific suggestions: what to pay off first
// and why, where an extra payment does the most good, and a cash-buffer sanity check. General
// guidance only — the UI shows a "not financial advice" line, same posture as the tax estimates.
//
// GET ?check → { configured }. POST { debts:[{name,balance,apr,minPayment,payment,termMonths}],
// cash, monthlyIncome, monthlyExpense, monthlyNet, fromBank, goals:[{name,target,saved}] } →
// { advice }. OWNER-ONLY (same gate as the bank endpoints — this is the owner's full debt picture).

import { aiConfigured, callClaude, setCors } from "./_ai.js";
import { requireOwner } from "./plaid/_plaid.js";

const n = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
const money = (v) => `$${Math.round(n(v)).toLocaleString()}`;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) return res.status(200).json({ ok: true, configured: aiConfigured() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const u = await requireOwner(req, res, "the payoff strategy"); if (!u) return;

  const b = req.body || {};
  const debts = (Array.isArray(b.debts) ? b.debts : []).filter(d => d && n(d.balance) > 0);
  if (!debts.length) return res.status(400).json({ error: "Add at least one debt with a balance first." });

  const lines = debts.map((d, i) => {
    const bits = [`${i + 1}. ${d.name || `Debt ${i + 1}`}: balance ${money(d.balance)}, APR ${n(d.apr)}%`];
    if (n(d.minPayment) > 0) bits.push(`minimum payment ${money(d.minPayment)}/mo`);
    if (n(d.payment) > 0) bits.push(`currently paying ${money(d.payment)}/mo`);
    if (n(d.termMonths) > 0) bits.push(`loan length ${Math.round(n(d.termMonths))} months`);
    return bits.join(", ");
  });
  const ctx = [
    `Debts:\n${lines.join("\n")}`,
    `Cash on hand: ${money(b.cash)}.`,
    `Monthly money in: ${money(b.monthlyIncome)}. Monthly money out: ${money(b.monthlyExpense)}. Net cash flow: ${money(b.monthlyNet)}/mo${b.fromBank ? " (from their connected bank — real figures)" : " (estimated from their operations data)"}.`,
    (Array.isArray(b.goals) && b.goals.length) ? `Savings goals: ${b.goals.map(g => `${g.name || "Goal"} (${money(g.saved)} of ${money(g.target)})`).join("; ")}.` : "",
  ].filter(Boolean).join("\n");

  const system = [
    "You advise the owner of a small property-service business on paying down their debts. You are practical and numerate — every suggestion uses their actual dollar figures.",
    "Produce 4-6 short bullets (each 1-2 sentences, start each with \"• \"), ordered by importance:",
    "(1) The single most important action first.",
    "(2) A payoff order with a one-line why — default to highest-APR-first (avalanche), but call out a small balance worth clearing quickly for the freed-up payment.",
    "(3) Whether their cash flow supports extra payments, and roughly what an extra $100-250/mo toward the top target saves in interest and time.",
    "(4) A cash-buffer check: months of expenses their cash covers; if under ~2 months, say to build the buffer before aggressive payoff.",
    "(5) Flag anything broken: paying below the minimum, or a payment that doesn't cover interest (balance won't drop).",
    "Hard rules: plain English, no jargon, no markdown headers or bold, only \"• \" bullets. Never invent numbers — compute from what's given; round to whole dollars. If a needed number is missing, skip that point rather than guessing.",
    "End with exactly this line (no bullet): General guidance, not financial advice — run big moves past your accountant.",
  ].join(" ");

  try {
    const advice = await callClaude({ system, content: ctx, maxTokens: 700, temperature: 0.4 });
    if (!advice) return res.status(502).json({ error: "The AI returned an empty answer — try again." });
    return res.status(200).json({ ok: true, advice });
  } catch (e) {
    if (e.missingEnv) return res.status(501).json({ error: e.message, missingEnv: true });
    return res.status(502).json({ error: e.message || "Couldn't get suggestions." });
  }
}
