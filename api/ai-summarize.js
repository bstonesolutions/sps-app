// api/ai-summarize.js
// Turns a completed visit's logged data (tests, treatments, parts, notes, photos) into a short,
// warm, non-technical recap addressed to the homeowner — the "AI visit summary". The app collects
// everything already; this just rewrites it like a human would. Returns { summary }.
//
// GET ?check → { configured } so the UI can show a "connect AI" state. POST does the work.

import { requireUser } from "./_auth.js";
import { aiConfigured, callClaude, setCors } from "./_ai.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) return res.status(200).json({ ok: true, configured: aiConfigured() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const u = await requireUser(req, res); if (!u) return;

  const b = req.body || {};
  const company = b.company || "us";
  const firstName = b.clientFirst || "there";
  const lines = [];
  if (b.serviceType) lines.push(`Service performed: ${b.serviceType}`);
  if (b.readings && typeof b.readings === "object") {
    const r = Object.entries(b.readings).filter(([, v]) => v !== "" && v != null && v !== "—");
    if (r.length) lines.push(`Water test readings: ${r.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  if (Array.isArray(b.treatments) && b.treatments.length) lines.push(`Treatments applied: ${b.treatments.map(t => `${t.name}${t.oz ? ` (${t.oz} ${t.unit || "oz"})` : ""}`).join(", ")}`);
  if (Array.isArray(b.parts) && b.parts.length) lines.push(`Parts/equipment: ${b.parts.map(p => p.name || p).join(", ")}`);
  if (b.notes) lines.push(`Technician notes: ${b.notes}`);
  if (b.photoCount) lines.push(`${b.photoCount} photo${b.photoCount > 1 ? "s" : ""} were taken and are in the client's portal.`);
  if (!lines.length) lines.push("A routine maintenance visit was completed with nothing unusual to report.");

  const system = [
    `You write a short recap of a completed property-service visit (pond / pool / seasonal care), addressed directly to the homeowner ("${firstName}").`,
    `Voice: warm, reassuring, plain-English — like a friendly local pro, not a lab report.`,
    `Rules: 2-3 sentences, no markdown, no bullet points. Do NOT add a greeting line or a sign-off (the app wraps those around it). Translate jargon into everyday terms (e.g. pH = "water balance"; ammonia/nitrite = "water health"). If readings look healthy, say so positively. Never invent problems or numbers that aren't in the data. Mention the photos only if some were taken. Keep it specific to what was actually done.`,
  ].join(" ");
  const content = `Company name: ${company}. Write the recap for ${firstName} based on this visit:\n${lines.join("\n")}`;

  try {
    const summary = await callClaude({ system, content, maxTokens: 320, temperature: 0.6 });
    return res.status(200).json({ ok: true, summary });
  } catch (e) {
    return res.status(e.missingEnv ? 501 : 502).json({ error: e.message || "AI request failed", missingEnv: !!e.missingEnv });
  }
}
