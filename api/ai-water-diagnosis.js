// api/ai-water-diagnosis.js
// Looks at a stop's water-test readings (current + recent history for trends) and, if photos are
// provided, the photos themselves (algae, clarity, equipment), then flags issues early and suggests
// treatments/products to recommend to the client. Returns structured JSON the app renders as cards.
//
// GET ?check → { configured }. POST body:
//   { serviceType, readings:{pH,...}, history:[{date, readings:{...}}], photoUrls:[...],
//     catalog:[{name, retail, unit}], clientFirst, division }

import { requireUser } from "./_auth.js";
import { aiConfigured, callClaude, extractJson, setCors } from "./_ai.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) return res.status(200).json({ ok: true, configured: aiConfigured() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const u = await requireUser(req, res); if (!u) return;

  const b = req.body || {};
  const div = b.division || "Pond";
  const fmtReadings = (r) => (r && typeof r === "object") ? Object.entries(r).filter(([, v]) => v !== "" && v != null && v !== "—").map(([k, v]) => `${k}=${v}`).join(", ") : "(none)";
  const trend = Array.isArray(b.history) ? b.history.slice(0, 5).map(h => `  ${h.date || "?"}: ${fmtReadings(h.readings)}`).join("\n") : "";
  const catalog = Array.isArray(b.catalog) ? b.catalog.slice(0, 40).map(t => `${t.name}${t.retail != null ? ` ($${t.retail}${t.unit ? "/" + t.unit : ""})` : ""}`).join(", ") : "";

  const textPart = [
    `You are a senior ${div.toLowerCase()} / water-care technician reviewing a client's water for a property-service business.`,
    ``,
    `CURRENT readings: ${fmtReadings(b.readings)}`,
    trend ? `RECENT readings (newest first), to judge trends:\n${trend}` : `No prior readings available — judge from the current values only.`,
    catalog ? `\nTreatments/products available to recommend (with retail price): ${catalog}` : ``,
    ``,
    `Assess water health, flag any problems (out-of-range values, worsening trends, and — if photos are included — visible algae, cloudiness, or equipment issues). Recommend specific treatments from the list above where they'd genuinely help (these double as upsells), with a one-line plain-English reason the client would understand. Be conservative: do not invent problems; if the water looks healthy, say so.`,
    ``,
    `Reply with ONLY a JSON object, no prose, in this exact shape:`,
    `{"healthy": boolean, "summary": "one friendly sentence for the owner", "issues": [{"title": "short", "detail": "plain-English explanation", "severity": "low|medium|high"}], "recommendations": [{"name": "treatment/product name from the list if possible", "reason": "why, in one line"}]}`,
  ].join("\n");

  // Vision: attach up to 3 photos — either uploaded URLs or fresh on-device base64 data URLs.
  let content = textPart;
  const blocks = [];
  for (const u of (Array.isArray(b.photoUrls) ? b.photoUrls : []).slice(0, 3)) {
    if (typeof u !== "string") continue;
    if (/^https?:\/\//.test(u)) blocks.push({ type: "image", source: { type: "url", url: u } });
    else { const m = u.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/); if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }); }
  }
  if (blocks.length) content = [{ type: "text", text: textPart }, ...blocks];

  try {
    const raw = await callClaude({ content, maxTokens: 900, temperature: 0.3 });
    const parsed = extractJson(raw);
    if (!parsed) return res.status(200).json({ ok: true, healthy: true, summary: raw.slice(0, 400), issues: [], recommendations: [] });
    return res.status(200).json({
      ok: true,
      healthy: !!parsed.healthy,
      summary: String(parsed.summary || "").slice(0, 400),
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 6) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 6) : [],
    });
  } catch (e) {
    return res.status(e.missingEnv ? 501 : 502).json({ error: e.message || "AI request failed", missingEnv: !!e.missingEnv });
  }
}
