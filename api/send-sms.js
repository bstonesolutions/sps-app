// api/send-sms.js
// Sends an SMS through Quo (formerly OpenPhone) from the business number, so texts
// go out automatically from the company line — no device Messages app, no tech's
// personal number.
//
// Required env (set in Vercel): QUO_API_KEY, QUO_PHONE_NUMBER (business # in E.164)
// API: POST https://api.quo.com/v1/messages  ·  Authorization: <key> (no "Bearer")
//      body { content, from, to: [ ... ] }  ·  numbers in E.164 (+1234567890)
//
// CORS is permissive so the native app (capacitor://localhost) can call it
// cross-origin via the absolute PROD_URL; the web build calls it same-origin.

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Best-effort E.164 (defaults to US +1 for 10-digit numbers).
function toE164(s) {
  const raw = String(s == null ? "" : s).trim();
  if (raw.startsWith("+")) return "+" + raw.slice(1).replace(/\D/g, "");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d ? "+" + d : "";
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const KEY = process.env.QUO_API_KEY;
  const FROM = process.env.QUO_PHONE_NUMBER;

  if (req.method === "GET" || (req.query && req.query.check)) {
    // Best-effort: list the numbers on the Quo account so the app can offer a picker
    // and validate the chosen Sending Identity texting number.
    let numbers = [];
    if (KEY) {
      try {
        const nr = await fetch("https://api.quo.com/v1/phone-numbers", { headers: { "Authorization": KEY } });
        const nd = await nr.json().catch(() => ({}));
        const list = Array.isArray(nd?.data) ? nd.data : (Array.isArray(nd) ? nd : []);
        numbers = list.map(n => {
          const num = n.e164 || n.phoneNumber || n.number || n.formattedNumber || "";
          return num ? { number: toE164(num), label: n.name || n.label || "" } : null;
        }).filter(Boolean);
      } catch (_) { /* listing is best-effort — the manual number still works */ }
    }
    return res.status(200).json({ ok: true, endpoint: "send-sms", configured: { quoKey: !!KEY, quoNumber: !!FROM }, from: FROM ? toE164(FROM) : null, numbers });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!KEY) return res.status(501).json({ error: "Texting is not configured on the server.", missingEnv: true });

  const { to, message, from } = req.body || {};
  const toNum = toE164(to);
  // Prefer the caller's "from" (the Sending Identity texting number) when it's a valid
  // number; otherwise fall back to the server default. Quo rejects any number that
  // isn't on the connected account, so a bad value can't impersonate an outside line.
  const fromNum = toE164(from) || toE164(FROM);
  if (!fromNum) return res.status(501).json({ error: "No business texting number is configured.", missingEnv: true });
  if (!toNum) return res.status(400).json({ error: "A valid recipient phone number is required." });
  if (!message || !String(message).trim()) return res.status(400).json({ error: "A message is required." });

  try {
    const r = await fetch("https://api.quo.com/v1/messages", {
      method: "POST",
      headers: { "Authorization": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(message), from: fromNum, to: [toNum] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = data?.message || data?.error || (data?.errors && data.errors[0] && (data.errors[0].message || data.errors[0].title)) || `Quo error ${r.status}`;
      return res.status(502).json({ error: reason, details: data });
    }
    return res.status(200).json({ sent: true, id: (data && (data.data?.id || data.id)) || null });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to send text" });
  }
}
