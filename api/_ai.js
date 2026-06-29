// api/_ai.js
// Shared Anthropic (Claude) helper for the app's AI features. ONE place that talks to the API, so
// every feature degrades the same way: if ANTHROPIC_API_KEY isn't set yet, callClaude throws a
// { missingEnv: true } error and the feature shows a clean "add your key" state instead of breaking.
//
// Env (Vercel): ANTHROPIC_API_KEY (required to turn AI on). Optional ANTHROPIC_MODEL to override the
// default model. NOTE: helper module, not an HTTP route — no default export.

const KEY = process.env.ANTHROPIC_API_KEY;
// Latest balanced model — capable enough for great client-facing copy + water analysis, far cheaper
// and faster than Opus for a per-visit feature. Override with ANTHROPIC_MODEL if you want.
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export const aiConfigured = () => !!KEY;

// content: a string (text-only) OR an array of Anthropic content blocks (for vision —
// e.g. [{type:"text",text}, {type:"image", source:{type:"url", url}}]).
export async function callClaude({ system, content, maxTokens = 1024, model, temperature }) {
  if (!KEY) { const e = new Error("AI isn't connected yet — add your ANTHROPIC_API_KEY in Vercel to turn it on."); e.missingEnv = true; throw e; }
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data?.error?.message || `Anthropic error ${r.status}`); e.status = r.status; throw e; }
  return (Array.isArray(data.content) ? data.content : []).filter(b => b.type === "text").map(b => b.text).join("").trim();
}

// Pull the first {...} or [...] JSON object out of a model reply (in case it adds prose around it).
export function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
