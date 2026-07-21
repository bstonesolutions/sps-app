// api/send-sms.js
// Sends an SMS through Quo (formerly OpenPhone) from one of two server-owned SPS lines:
//   - automation (default): reminders, reports, invoices, On My Way, etc.
//   - main: the owner's newly ported Comms number (or an explicitly granted delegate).
// A caller can select only the role, never an arbitrary workspace number.
//
// Required env (set in Vercel): QUO_API_KEY, QUO_PHONE_NUMBER (automation line, E.164)
// Optional until direct comms is enabled: QUO_MAIN_PHONE_NUMBER (ported main line, E.164)
// API: POST https://api.quo.com/v1/messages  ·  Authorization: <key> (no "Bearer")
//      body { content, from, to: [ ... ] }  ·  numbers in E.164 (+1234567890)
//
// CORS is permissive so the native app (capacitor://localhost) can call it
// cross-origin via the absolute PROD_URL; the web build calls it same-origin.

import { memberHasCapability, requireStaff } from "./_staff-auth.js";
import { ensureClientLinkChoices } from "../clientMessageLinks.js";
import {
  claimSmsDelivery,
  finalizeSmsDelivery,
  normalizeSmsIdempotencyKey,
  smsRequestFingerprint,
} from "./_sms-idempotency.js";
import {
  cleanSmsValue,
  legacySmsInboxRow,
  parseTestRedirect,
  quoContactMetadata,
  smsHistorySchemaMissing,
} from "./_sms-history.js";

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

function displayPhone(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(-10);
  return digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : String(value || "");
}

async function storeOutgoingHistory({
  providerMessage,
  line,
  peer,
  content,
  clientId,
  redirected,
}) {
  if (!SERVICE_KEY) return { stored: false, reason: "service key missing" };
  const providerId = cleanSmsValue(providerMessage?.id, 100);
  if (!providerId) return { stored: false, reason: "Quo response had no message id" };
  const legacyRedirect = parseTestRedirect(content);
  const historyPeer = legacyRedirect?.intendedPeer || peer;
  const historyContent = legacyRedirect?.content || content;
  const wasRedirected = redirected || !!legacyRedirect;
  const embeddedContact = quoContactMetadata(providerMessage?.contact);
  const contactId = embeddedContact.id || cleanSmsValue(providerMessage?.contactId, 100);
  const contactName = embeddedContact.name || cleanSmsValue(providerMessage?.contactName, 180);
  const id = `sms_out_${providerId}`;
  const ai = {
    quoLine: line,
    smsDirection: "outgoing",
    ...(clientId ? { clientId } : {}),
    ...(wasRedirected ? { testRedirected: true, intendedPeer: historyPeer } : {}),
  };
  const row = {
    id,
    channel: "sms",
    from_phone: historyPeer,
    from_name: displayPhone(historyPeer),
    from_email: displayPhone(historyPeer),
    subject: cleanSmsValue(historyContent, 80) || "(text message)",
    body_text: cleanSmsValue(historyContent, 4000),
    body_html: "",
    message_id: providerId,
    kind: clientId ? "client" : "other",
    ai,
    lead_id: "",
    read: true,
    replied: true,
    sms_direction: "outgoing",
    sms_line: line,
    sms_peer_phone: historyPeer,
    quo_message_id: providerId,
    // A Test Mode carrier conversation belongs to the test phone, not the intended client. Let
    // the app group it by protected line + intended peer instead of attaching the wrong Quo id.
    quo_conversation_id: wasRedirected ? null : (cleanSmsValue(providerMessage?.conversationId, 120) || null),
    quo_phone_number_id: cleanSmsValue(providerMessage?.phoneNumberId, 120) || null,
    sms_status: wasRedirected ? "test_redirected" : cleanSmsValue(providerMessage?.status, 40) || "accepted",
    sms_media: [],
    quo_contact_id: contactId || null,
    sms_contact_name: contactName || null,
    sms_provider_created_at: cleanSmsValue(providerMessage?.createdAt, 60) || null,
  };
  const insert = async (value) => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?on_conflict=id`, {
      method: "POST",
      headers: { ...serviceHeaders(), Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([value]),
    });
    const text = response.ok ? "" : await response.text().catch(() => "");
    return { response, text };
  };
  try {
    let result = await insert(row);
    let legacySchema = false;
    if (!result.response.ok && smsHistorySchemaMissing(result.text)) {
      result = await insert(legacySmsInboxRow(row));
      legacySchema = result.response.ok;
    }
    if (!result.response.ok) return { stored: false, reason: result.text.slice(0, 160) || `HTTP ${result.response.status}` };
    const rows = await result.response.json().catch(() => []);
    return { stored: true, duplicate: !Array.isArray(rows) || rows.length === 0, legacySchema, id };
  } catch (error) {
    return { stored: false, reason: cleanSmsValue(error?.message || error, 160) || "history insert failed" };
  }
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

async function lineForInboxReply(inboxId) {
  if (!SERVICE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const id = String(inboxId || "").trim();
  if (!id || id.length > 120) throw new Error("invalid inbox message");
  let response;
  try {
    response = await fetch(
      `${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(id)}&select=id,channel,from_phone,ai&limit=2`,
      { headers: serviceHeaders() },
    );
  } catch (error) {
    throw new Error(`inbox reply lookup failed: ${error && error.message ? error.message : "network error"}`);
  }
  if (!response.ok) throw new Error(`inbox reply lookup failed (${response.status})`);
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.channel !== "sms") {
    throw new Error("inbox text was not found");
  }
  const ai = parseStoredValue(rows[0].ai);
  // Historical inbound texts predate multi-line support and could only have arrived on the
  // automation line, so a missing marker on an otherwise-valid object retains that legacy
  // behavior. Any malformed container or unknown non-empty marker fails closed: silently
  // downgrading it to automation could cross the owner/staff line boundary.
  if (ai != null && (typeof ai !== "object" || Array.isArray(ai))) {
    throw new Error("inbox text has malformed line metadata");
  }
  const rawLine = ai && typeof ai === "object"
    ? String(ai.quoLine == null ? "" : ai.quoLine).trim().toLowerCase()
    : "";
  if (rawLine && rawLine !== "automation" && rawLine !== "main") {
    throw new Error("inbox text has unknown line metadata");
  }
  const line = rawLine === "main" ? "main" : "automation";
  const recipient = toE164(rows[0].from_phone);
  if (!E164.test(recipient)) throw new Error("inbox text has no valid sender");
  return { line, recipient };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const KEY = process.env.QUO_API_KEY;
  const configuredFrom = toE164(process.env.QUO_PHONE_NUMBER);
  const configuredMainFrom = toE164(process.env.QUO_MAIN_PHONE_NUMBER);
  const duplicateConfiguredLines = !!configuredMainFrom && configuredMainFrom === configuredFrom;

  if (req.method === "GET") {
    // Keep the compatibility health check intentionally small: older installed builds call it
    // without auth. Exact line details and the upstream Quo check are staff-only.
    const configured = { quoKey: !!KEY, quoNumber: !!configuredFrom };
    if (!((req.query || {}).details === "1")) {
      return res.status(200).json({ ok: true, endpoint: "send-sms", configured });
    }
    const _u = await requireStaff(req, res, "viewing the business texting line");
    if (!_u) return;
    if (!memberHasCapability(_u.teamMember, "sendTexts")
      && !memberHasCapability(_u.teamMember, "commsTextInbox")
      && !memberHasCapability(_u.teamMember, "commsMainLine")
      && !memberHasCapability(_u.teamMember, "commsBroadcast")) {
      return res.status(403).json({ error: "Your team permissions do not allow viewing a business texting line." });
    }
    const canViewMainLine = _u.teamRole === "owner" || memberHasCapability(_u.teamMember, "commsMainLine");

    let upstreamReachable = false;
    let numberOnAccount = null;
    let mainNumberOnAccount = null;
    let lineLabel = "";
    let mainLineLabel = "";
    if (KEY) {
      try {
        const nr = await fetch("https://api.quo.com/v1/phone-numbers", { headers: { "Authorization": KEY } });
        upstreamReachable = nr.ok;
        if (nr.ok) {
          const nd = await nr.json().catch(() => ({}));
          const list = Array.isArray(nd?.data) ? nd.data : (Array.isArray(nd) ? nd : []);
          const numberOf = (n) => toE164(n.e164 || n.phoneNumber || n.number || n.formattedNumber || "");
          const match = list.find((n) => numberOf(n) === configuredFrom);
          // Do not resolve or report the owner's private line unless the owner granted visibility.
          const mainMatch = canViewMainLine ? list.find((n) => numberOf(n) === configuredMainFrom) : null;
          numberOnAccount = !!match;
          mainNumberOnAccount = canViewMainLine && configuredMainFrom ? !!mainMatch : null;
          lineLabel = match ? String(match.name || match.label || "") : "";
          mainLineLabel = mainMatch ? String(mainMatch.name || mainMatch.label || "") : "";
        }
      } catch (_) { /* surfaced through upstreamReachable=false */ }
    }
    return res.status(200).json({
      ok: true,
      endpoint: "send-sms",
      configured: {
        ...configured,
        upstreamReachable,
        numberOnAccount,
        ...(canViewMainLine ? {
          quoMainNumber: !!configuredMainFrom && !duplicateConfiguredLines,
          duplicateConfiguredLines,
          mainNumberOnAccount,
        } : {}),
      },
      from: configuredFrom || null,
      ...(canViewMainLine ? { directFrom: configuredMainFrom || null } : {}),
      // Exact server-approved lines only. Never enumerate unrelated numbers in the workspace.
      numbers: [
        ...(configuredFrom ? [{ role: "automation", number: configuredFrom, label: lineLabel }] : []),
        ...(canViewMainLine && configuredMainFrom && !duplicateConfiguredLines ? [{ role: "main", number: configuredMainFrom, label: mainLineLabel }] : []),
      ],
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Gate the privileged send path (the GET "?check"/health branch above stays open). An explicit
  // Broadcast grant may use only the automation line for messages marked as broadcasts. It does not
  // unlock ordinary direct texts, shared-inbox replies, or the owner's ported number.
  const _u = await requireStaff(req, res, "sending client text messages");
  if (!_u) return;
  const requestedPurpose = String((req.body || {}).purpose || "").trim().toLowerCase();
  const canSendTexts = memberHasCapability(_u.teamMember, "sendTexts");
  const canBroadcast = requestedPurpose === "broadcast" && memberHasCapability(_u.teamMember, "commsBroadcast");
  if (!canSendTexts && !canBroadcast) {
    return res.status(403).json({ error: "Your team permissions do not allow sending client text messages." });
  }

  if (!KEY) return res.status(501).json({ error: "Texting is not configured on the server.", missingEnv: true });

  const { to, message } = req.body || {};
  const toNum = toE164(to);
  const rawClientId = (req.body || {}).clientId;
  const clientId = (typeof rawClientId === "string" || typeof rawClientId === "number")
    ? String(rawClientId).trim()
    : "";
  const messageType = String((req.body || {}).messageType || "").trim();
  let idempotencyKey = "";
  try {
    idempotencyKey = normalizeSmsIdempotencyKey((req.body || {}).idempotencyKey, messageType);
  } catch (_) {
    return res.status(400).json({ error: "This arrival text has an invalid delivery key. No message was sent." });
  }
  const inboxId = String((req.body || {}).inboxId || "").trim();
  const ownerSender = _u.teamRole === "owner";
  let line;
  if (inboxId) {
    if (!canSendTexts) {
      return res.status(403).json({ error: "Your team permissions do not allow replying from the business text inbox." });
    }
    // A schedule-only texting grant must not open either shared inbox. Visibility can be granted
    // independently per line, but only the owner may send through the owner's ported number.
    const canViewAutomation = memberHasCapability(_u.teamMember, "commsTextInbox");
    const canViewMain = ownerSender || memberHasCapability(_u.teamMember, "commsMainLine");
    if (!canViewAutomation && !canViewMain) {
      return res.status(403).json({ error: "Your team permissions do not allow replying from the business text inbox." });
    }
    try {
      const replyContext = await lineForInboxReply(inboxId);
      line = replyContext.line;
      // Check the private line before comparing caller-supplied recipients so an unauthorized
      // delegate cannot use different status codes to probe the phone number on a main-line row.
      if (line === "main" && !ownerSender) {
        return res.status(403).json({ error: "Only the owner can send from the owner's work line." });
      }
      if (line === "automation" && !canViewAutomation) {
        return res.status(403).json({ error: "Your team permissions do not allow replying from the staff text inbox." });
      }
      if (replyContext.recipient !== toNum) {
        return res.status(400).json({ error: "The reply recipient does not match the original inbound text. No message was sent." });
      }
    } catch (error) {
      console.error("[send-sms] inbox reply line unavailable:", error && error.message ? error.message : error);
      return res.status(503).json({ error: "The original text line could not be verified. No reply was sent." });
    }
  } else {
    const rawLine = String((req.body || {}).line || "automation").trim().toLowerCase();
    if (!["automation", "main"].includes(rawLine)) return res.status(400).json({ error: "Unknown business texting line." });
    line = rawLine === "main" ? "main" : "automation";
  }
  // `sendTexts` intentionally remains enough for the staff/automation number. Main-line visibility
  // never implies sender authority: the ported owner number is owner-send only on the server.
  if (line === "main" && !ownerSender) {
    return res.status(403).json({ error: "Only the owner can send from the owner's work line." });
  }
  if (canBroadcast && !canSendTexts && line !== "automation") {
    return res.status(403).json({ error: "Staff broadcasts must use the automation texting line." });
  }
  // The server owns both sender identities. The app can request a role, but cannot inject `from`.
  if (line === "main" && duplicateConfiguredLines) return res.status(501).json({ error: "The main and automation Quo numbers must be different.", missingEnv: true, line });
  const fromNum = line === "main" ? configuredMainFrom : configuredFrom;
  if (!fromNum) return res.status(501).json({
    error: line === "main" ? "The main Quo work number is not configured yet." : "No automation texting number is configured.",
    missingEnv: true,
    line,
  });
  if (!E164.test(fromNum)) return res.status(501).json({ error: `The ${line} texting number is invalid.`, missingEnv: true, line });
  if (!E164.test(toNum)) return res.status(400).json({ error: "Enter a valid recipient phone number, including its country code." });
  const content = String(message == null ? "" : message).trim();
  if (!content) return res.status(400).json({ error: "A message is required." });
  if (content.length > 1600) return res.status(400).json({ error: "Text messages are limited to 1,600 characters." });
  let normalizedContent;
  try {
    normalizedContent = ensureClientLinkChoices(content, { messageType: (req.body || {}).messageType });
  } catch (_) {
    return res.status(400).json({ error: "The SPS Way link in this text is too long. Shorten or replace it before sending." });
  }

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
  let safeContent = normalizedContent;
  let redirected = false;
  let heldByTestMode = false;
  if (textSafety.on) {
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
        heldByTestMode = true;
      } else {
        safeTo = textSafety.phone;
        const prefix = `[TEST → ${toNum}] `;
        safeContent = `${prefix}${normalizedContent}`.slice(0, 1600);
        redirected = true;
      }
    }
  }

  // Arrival confirmation can be opened from both a manual Schedule action and native geofence
  // detection. Claim the stable stop key before Quo is contacted, so reloads, two devices, and an
  // ambiguous network response cannot turn those two surfaces into duplicate client texts.
  let deliveryClaim = null;
  if (idempotencyKey) {
    const requestHash = smsRequestFingerprint({ line, from: fromNum, to: safeTo, clientId, content: safeContent });
    try {
      deliveryClaim = await claimSmsDelivery({ idempotencyKey, requestHash });
    } catch (error) {
      console.error("[send-sms] delivery receipt unavailable:", error && error.message ? error.message : error);
      return res.status(503).json({
        error: "Arrival text safety is temporarily unavailable. No text was sent.",
        accepted: false,
        sent: false,
        held: false,
        uncertain: false,
        retrySafe: true,
      });
    }
    if (deliveryClaim.outcome === "mismatch") {
      return res.status(409).json({
        error: "This arrival was already confirmed with different text details. No second text was sent.",
        accepted: false,
        sent: false,
        held: false,
        uncertain: false,
        retrySafe: false,
      });
    }
    if (deliveryClaim.outcome === "accepted") {
      return res.status(202).json({
        accepted: true,
        sent: true,
        held: false,
        redirected,
        replayed: true,
        retrySafe: false,
        deliveryState: "accepted",
        line,
        id: deliveryClaim.receipt.providerId || null,
      });
    }
    if (deliveryClaim.outcome === "held") {
      return res.status(200).json({
        accepted: false,
        sent: false,
        held: true,
        redirected: false,
        testMode: true,
        replayed: true,
        retrySafe: false,
        deliveryState: "held",
        line,
      });
    }
    if (deliveryClaim.outcome === "sending" || deliveryClaim.outcome === "uncertain") {
      return res.status(202).json({
        error: "Quo delivery is already in progress or could not be confirmed. Check Comms before sending another text.",
        accepted: false,
        sent: false,
        held: false,
        uncertain: true,
        retrySafe: false,
        replayed: true,
        deliveryState: deliveryClaim.outcome === "sending" ? "in_progress" : "uncertain",
        line,
      });
    }
    if (deliveryClaim.outcome !== "claimed") {
      return res.status(409).json({
        error: "This arrival text cannot be safely sent again. Check Comms before sending another message.",
        accepted: false,
        sent: false,
        held: false,
        uncertain: false,
        retrySafe: false,
        deliveryState: deliveryClaim.outcome || "blocked",
        line,
      });
    }
  }

  const settleDelivery = async (state, options = {}) => {
    if (!deliveryClaim) return true;
    try {
      const settled = await finalizeSmsDelivery(deliveryClaim, { state, ...options });
      return settled.changed || settled.receipt?.state === state;
    } catch (error) {
      // The pre-send claim remains durable. Leaving it in `sending` deliberately blocks a blind
      // retry if the final database write fails after Quo may already have accepted the message.
      console.error("[send-sms] delivery receipt finalize failed:", error && error.message ? error.message : error);
      return false;
    }
  };

  if (heldByTestMode) {
    const receiptStored = await settleDelivery("held");
    return res.status(200).json({
      accepted: false,
      sent: false,
      held: true,
      redirected: false,
      testMode: true,
      line,
      ...(deliveryClaim ? { retrySafe: false, deliveryState: "held", receiptStored } : {}),
    });
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
      const uncertain = r.status >= 500 || r.status === 408;
      const receiptStored = await settleDelivery(uncertain ? "uncertain" : "failed", { retrySafe: !uncertain });
      const reason = r.status === 402
        ? "The texting account needs more prepaid credit."
        : r.status === 401 || r.status === 403
          ? "The business texting connection needs attention."
          : r.status === 429
            ? "The texting service is busy. Please wait a moment and try again."
            : "The texting service could not send that message. Please try again.";
      if (!deliveryClaim) return res.status(502).json({ error: reason });
      return res.status(502).json({
        error: uncertain
          ? "Quo may already have accepted this text. Check Comms before sending another message."
          : reason,
        accepted: false,
        sent: false,
        held: false,
        uncertain,
        retrySafe: !uncertain,
        deliveryState: uncertain ? "uncertain" : "failed",
        receiptStored,
        line,
      });
    }
    const providerMessage = data && typeof data === "object" && data.data && typeof data.data === "object"
      ? data.data
      : data;
    const providerId = (providerMessage && providerMessage.id) || null;
    const receiptStored = await settleDelivery("accepted", { providerId });
    // Persist the intended counterparty immediately, even when Test Mode delivered the carrier
    // message to the owner's test device. message.delivered later enriches this exact provider id
    // with the Quo conversation id and final status. History storage cannot turn a Quo-accepted
    // send into an apparent failure, which would invite staff to send a duplicate.
    const history = await storeOutgoingHistory({
      providerMessage,
      line,
      peer: toNum,
      content: normalizedContent,
      clientId,
      redirected,
    });
    if (!history.stored) {
      console.error("[send-sms] Quo accepted text but history insert failed:", history.reason || "unknown error");
    }
    // Quo has accepted the message for sending. Carrier delivery is a separate webhook event,
    // so keep `sent` only for compatibility with installed v1.1 clients and expose the truth too.
    return res.status(202).json({
      accepted: true,
      sent: true,
      held: false,
      redirected,
      line,
      id: providerId,
      historyStored: !!history.stored,
      historyId: history.stored ? history.id : null,
      historyPendingWebhook: !history.stored,
      ...(deliveryClaim ? { replayed: false, retrySafe: false, deliveryState: "accepted", receiptStored } : {}),
    });
  } catch (err) {
    console.error("[send-sms] Quo request failed:", err && err.message ? err.message : err);
    const receiptStored = await settleDelivery("uncertain");
    if (!deliveryClaim) return res.status(502).json({ error: "The texting service could not be reached. Please try again." });
    return res.status(502).json({
      error: "Quo may already have accepted this text. Check Comms before sending another message.",
      accepted: false,
      sent: false,
      held: false,
      uncertain: true,
      retrySafe: false,
      deliveryState: "uncertain",
      receiptStored,
      line,
    });
  }
}
