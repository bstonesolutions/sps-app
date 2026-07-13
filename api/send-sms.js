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

import { requireCapability } from "./_staff-auth.js";

const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://ysqarusrewceezckawlo.supabase.co"
).replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Authorization");
}

// Quo accepts E.164 up to 15 digits. Require at least 8 total digits as a practical guard against
// malformed partial numbers while keeping international destinations valid.
const E164 = /^\+[1-9]\d{7,14}$/;

// Normalize familiar US input while still requiring Quo's E.164 format at the API boundary.
function toE164(s) {
  const raw = String(s == null ? "" : s).trim();
  if (raw.startsWith("+")) return "+" + raw.slice(1).replace(/\D/g, "");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d ? "+" + d : "";
}

function parseStoredValue(value) {
  let parsed = value;
  // app_state has existed as both JSONB and a JSON string inside JSONB. Match the reader used by
  // staff authorization so Test Mode cannot be bypassed by the older representation.
  for (let i = 0; i < 2 && typeof parsed === "string"; i += 1) {
    try { parsed = JSON.parse(parsed); } catch { break; }
  }
  return parsed;
}

function serviceHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function loadTextSafety() {
  if (!SERVICE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  let response;
  try {
    response = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?key=eq.sps_email&select=value`,
      { headers: serviceHeaders() },
    );
  } catch (error) {
    throw new Error(`text safety lookup failed: ${error && error.message ? error.message : "network error"}`);
  }
  if (!response.ok) throw new Error(`text safety lookup failed (${response.status})`);
  const rows = await response.json().catch(() => null);
  const email = Array.isArray(rows) && rows[0] ? parseStoredValue(rows[0].value) : null;
  if (!email || typeof email !== "object" || Array.isArray(email)) {
    throw new Error("sps_email is missing or malformed");
  }
  if (!email.testMode || typeof email.testMode !== "object" || Array.isArray(email.testMode)) {
    throw new Error("sps_email.testMode is malformed");
  }
  const testMode = email.testMode;
  const savedOn = testMode.on;
  const savedOnText = typeof savedOn === "string" ? savedOn.trim().toLowerCase() : "";
  if (savedOn !== true && savedOn !== false && savedOnText !== "true" && savedOnText !== "false") {
    throw new Error("sps_email.testMode.on is missing or malformed");
  }
  return {
    on: savedOn === true || savedOnText === "true",
    mode: testMode.mode === "hold" ? "hold" : "redirect",
    phone: toE164(testMode.phone),
    liveClientIds: new Set(
      (Array.isArray(testMode.liveClientIds) ? testMode.liveClientIds : [])
        .filter((id) => typeof id === "string" || typeof id === "number")
        .map((id) => String(id).trim())
        .filter(Boolean),
    ),
  };
}

async function pilotMatchesDestination(clientId, toNum) {
  let response;
  try {
    response = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?key=eq.sps_clients&select=value`,
      { headers: serviceHeaders() },
    );
  } catch (error) {
    throw new Error(`pilot client lookup failed: ${error && error.message ? error.message : "network error"}`);
  }
  if (!response.ok) throw new Error(`pilot client lookup failed (${response.status})`);
  const rows = await response.json().catch(() => null);
  const clients = Array.isArray(rows) && rows[0] ? parseStoredValue(rows[0].value) : null;
  if (!Array.isArray(clients)) throw new Error("sps_clients is missing or malformed");
  const matches = clients.filter((client) => client && String(client.id) === clientId);
  if (matches.length !== 1) return false;
  const client = matches[0];
  const textPreference = client.notifyPrefs && client.notifyPrefs.channels
    ? client.notifyPrefs.channels.text
    : undefined;
  return textPreference !== false && toE164(client.phone || client.contactPhone) === toNum;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const KEY = process.env.QUO_API_KEY;
  const FROM = process.env.QUO_PHONE_NUMBER;
  const configuredFrom = toE164(FROM);

  if (req.method === "GET") {
    // Keep the compatibility health check intentionally small: older installed builds call it
    // without auth. Exact line details and the upstream Quo check are staff-only.
    const configured = { quoKey: !!KEY, quoNumber: !!configuredFrom };
    if (!((req.query || {}).details === "1")) {
      return res.status(200).json({ ok: true, endpoint: "send-sms", configured });
    }
    const _u = await requireCapability(req, res, "sendTexts", "viewing the business texting line");
    if (!_u) return;

    let upstreamReachable = false;
    let numberOnAccount = null;
    let lineLabel = "";
    if (KEY) {
      try {
        const nr = await fetch("https://api.quo.com/v1/phone-numbers", { headers: { "Authorization": KEY } });
        upstreamReachable = nr.ok;
        if (nr.ok) {
          const nd = await nr.json().catch(() => ({}));
          const list = Array.isArray(nd?.data) ? nd.data : (Array.isArray(nd) ? nd : []);
          const match = list.find((n) => toE164(n.e164 || n.phoneNumber || n.number || n.formattedNumber || "") === configuredFrom);
          numberOnAccount = !!match;
          lineLabel = match ? String(match.name || match.label || "") : "";
        }
      } catch (_) { /* surfaced through upstreamReachable=false */ }
    }
    return res.status(200).json({
      ok: true,
      endpoint: "send-sms",
      configured: { ...configured, upstreamReachable, numberOnAccount },
      from: configuredFrom || null,
      // Never expose or allow selection of unrelated lines in this Quo workspace.
      numbers: configuredFrom ? [{ number: configuredFrom, label: lineLabel }] : [],
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Gate the privileged send path (the GET "?check"/health branch above stays open).
  const _u = await requireCapability(req, res, "sendTexts", "sending client text messages");
  if (!_u) return;

  if (!KEY) return res.status(501).json({ error: "Texting is not configured on the server.", missingEnv: true });

  const { to, message } = req.body || {};
  const toNum = toE164(to);
  // The server owns the sender identity. A client/staff request may choose the recipient and
  // content within its capability, but it can never switch to another line in the Quo workspace.
  const fromNum = configuredFrom;
  if (!fromNum) return res.status(501).json({ error: "No business texting number is configured.", missingEnv: true });
  if (!E164.test(fromNum)) return res.status(501).json({ error: "The business texting number is invalid.", missingEnv: true });
  if (!E164.test(toNum)) return res.status(400).json({ error: "Enter a valid recipient phone number, including its country code." });
  const content = String(message == null ? "" : message).trim();
  if (!content) return res.status(400).json({ error: "A message is required." });
  if (content.length > 1600) return res.status(400).json({ error: "Text messages are limited to 1,600 characters." });

  // The saved server setting is authoritative. Client-side Test Mode is useful UX, but older
  // installed builds and direct API callers must not be able to send around it.
  let textSafety;
  try {
    textSafety = await loadTextSafety();
  } catch (error) {
    console.error("[send-sms] text safety settings unavailable:", error && error.message ? error.message : error);
    return res.status(503).json({
      error: "Text safety settings are temporarily unavailable. No message was sent.",
      accepted: false,
      sent: false,
      held: true,
      redirected: false,
    });
  }

  let safeTo = toNum;
  let safeContent = content;
  let redirected = false;
  if (textSafety.on) {
    const rawClientId = (req.body || {}).clientId;
    const clientId = (typeof rawClientId === "string" || typeof rawClientId === "number")
      ? String(rawClientId).trim()
      : "";
    const ownerTestDestination = !!textSafety.phone && toNum === textSafety.phone;
    let pilotLive = false;
    if (!ownerTestDestination && clientId && textSafety.liveClientIds.has(clientId)) {
      try {
        pilotLive = await pilotMatchesDestination(clientId, toNum);
      } catch (error) {
        console.error("[send-sms] pilot safety lookup unavailable:", error && error.message ? error.message : error);
        return res.status(503).json({
          error: "Text safety settings are temporarily unavailable. No message was sent.",
          accepted: false,
          sent: false,
          held: true,
          redirected: false,
        });
      }
    }

    if (!ownerTestDestination && !pilotLive) {
      if (textSafety.mode === "hold" || !E164.test(textSafety.phone)) {
        return res.status(200).json({
          accepted: false,
          sent: false,
          held: true,
          redirected: false,
          testMode: true,
        });
      }
      safeTo = textSafety.phone;
      const prefix = `[TEST → ${toNum}] `;
      safeContent = `${prefix}${content}`.slice(0, 1600);
      redirected = true;
    }
  }

  try {
    const r = await fetch("https://api.quo.com/v1/messages", {
      method: "POST",
      headers: { "Authorization": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ content: safeContent, from: fromNum, to: [safeTo] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("[send-sms] Quo rejected message:", r.status, data?.code || data?.title || data?.message || "unknown error");
      const reason = r.status === 402
        ? "The texting account needs more prepaid credit."
        : r.status === 401 || r.status === 403
          ? "The business texting connection needs attention."
          : r.status === 429
            ? "The texting service is busy. Please wait a moment and try again."
            : "The texting service could not send that message. Please try again.";
      return res.status(502).json({ error: reason });
    }
    // Quo has accepted the message for sending. Carrier delivery is a separate webhook event,
    // so keep `sent` only for compatibility with installed v1.1 clients and expose the truth too.
    return res.status(202).json({
      accepted: true,
      sent: true,
      held: false,
      redirected,
      id: (data && (data.data?.id || data.id)) || null,
    });
  } catch (err) {
    console.error("[send-sms] Quo request failed:", err && err.message ? err.message : err);
    return res.status(502).json({ error: "The texting service could not be reached. Please try again." });
  }
}
