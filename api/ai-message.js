// api/ai-message.js
// Polishes / drafts a short client-facing message for the Comms hub — reminder nudges, payment
// nudges, broadcasts, or a lead reply. Given the current draft (or none) + light context, it returns
// ONE warm, on-brand, SMS-appropriate message with the {placeholders} left intact so the app can fill
// them per recipient. Same graceful, key-gated pattern as ai-summarize.js.
//
// GET ?check → { configured }. POST body:
//   { kind, draft, context:{ clientFirst, company, service, date, amount, invoiceNumber, division }, channel }
//   kind: "reminder" | "payment" | "broadcast" | "lead_reply"   channel: "text" | "email"

import { requireUser } from "./_auth.js";
import { aiConfigured, callClaude, setCors } from "./_ai.js";

const KIND_INTENT = {
  reminder: "a friendly reminder that the client has an upcoming service appointment",
  payment: "a polite, no-pressure nudge that an invoice is past due, with the pay link",
  broadcast: "a broadcast message the business is sending to a group of clients",
  lead_reply: "a warm first reply to a new prospect who reached out",
};

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) return res.status(200).json({ ok: true, configured: aiConfigured() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const u = await requireUser(req, res); if (!u) return;

  const b = req.body || {};
  const c = b.context || {};
  const channel = b.channel === "email" ? "email" : "text";
  const intent = KIND_INTENT[b.kind] || KIND_INTENT.reminder;

  const ctxLines = [];
  if (c.company) ctxLines.push(`Business: ${c.company}`);
  if (c.clientFirst) ctxLines.push(`Recipient first name: ${c.clientFirst}`);
  if (c.service) ctxLines.push(`Service: ${c.service}`);
  if (c.division) ctxLines.push(`Division: ${c.division}`);
  if (c.date) ctxLines.push(`Date: ${c.date}`);
  if (c.amount) ctxLines.push(`Amount due: ${c.amount}`);
  if (c.invoiceNumber) ctxLines.push(`Invoice #: ${c.invoiceNumber}`);

  const system = [
    `You write ${channel === "email" ? "a short email" : "a single SMS text"} for a pond / pool / seasonal property-service business — ${intent}.`,
    `Voice: warm, plain-English, like a friendly local pro. ${channel === "text" ? "Keep it to 1-2 short sentences, well under 320 characters." : "Keep it to 2-4 short sentences."} No markdown, no emoji spam, no salesy hype.`,
    `IMPORTANT: keep any {curly placeholders} EXACTLY as written (e.g. {first}, {company}, {date}, {amount}, {number}, {link}) — the app fills them per recipient. Never invent numbers, dates, or a payment link. Do not add a subject line. Output ONLY the message text, nothing else.`,
    b.draft ? `Improve the owner's draft below — keep its intent + any placeholders, make it warmer and cleaner.` : `Write it fresh from the context.`,
  ].join(" ");
  const content = `${ctxLines.join("\n")}\n\n${b.draft ? `Draft to improve:\n${String(b.draft).slice(0, 800)}` : "Write the message."}`;

  try {
    const message = await callClaude({ system, content, maxTokens: 300, temperature: 0.6 });
    return res.status(200).json({ ok: true, message });
  } catch (e) {
    return res.status(e.missingEnv ? 501 : 502).json({ error: e.message || "AI request failed", missingEnv: !!e.missingEnv });
  }
}
