// api/sms-intake.js — inbound SMS funnel (Quo/OpenPhone `message.received` webhook).
//
// Someone texts the business number → this fires → the text flows into the SAME AI-sorted
// inbox as work email (sps_inbox, channel 'sms'): an existing client's text is tagged "Client";
// an unknown number is AI-triaged (lead/bill/other) and, when it's a lead, auto-imports into
// Comms → Leads with a push — exactly like an email lead. Outbound texts WE send ride the same
// Quo message stream with direction "outgoing"; we drop those so we never ingest our own sends.
//
// Auth: the webhook URL carries ?key=<QUO_WEBHOOK_KEY> and every POST must also have Quo's valid
// openphone-signature HMAC using QUO_WEBHOOK_SECRET. Both are mandatory. Valid requests return 2xx
// only after storage and notification delivery are durably complete (or deliberately skipped);
// retriable storage/delivery failures return 5xx so Quo retries for up to three days. The unique
// envelope id and delivery ledger make those retries safe. Ships dark until both secrets are set.
//
// One-time SQL: run SMS-INBOX-MIGRATION.sql to add channel + from_phone.

import crypto from "node:crypto";
import { callClaude, extractJson, aiConfigured } from "./_ai.js";
import { mutateAppState, NO_APP_STATE_CHANGE, readAppStateVersioned } from "./_app-state.js";
import { pushConfigured, pushOwner, pushStaff } from "./_push.js";
import { memberHasCapability } from "./_staff-auth.js";
import { assessInboundLead } from "../leadQualification.js";

export const config = { api: { bodyParser: false } }; // need the RAW body for HMAC verification

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KEY          = process.env.QUO_WEBHOOK_KEY;
const SIGN_SECRET  = process.env.QUO_WEBHOOK_SECRET; // Quo's base64 signing secret
const QUO_NUMBER   = process.env.QUO_PHONE_NUMBER;      // automation line
const QUO_MAIN_NUMBER = process.env.QUO_MAIN_PHONE_NUMBER; // ported main work line
export const INBOUND_TEXT_PUSH_LINK = "comms/inbox";

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
async function inboxStatus() {
  const empty = { schema: false, observed: false, lastInboundAt: null, observedLines: { automation: false, main: false }, lastInboundByLine: { automation: null, main: null } };
  if (!SERVICE_KEY) return empty;
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?select=id,channel,from_phone,created_at,ai&channel=eq.sms&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=100`, { headers: sbHeaders() });
    if (!r.ok) return empty;
    const rows = await r.json().catch(() => null);
    if (!Array.isArray(rows)) return empty;
    const lastInboundAt = Array.isArray(rows) && rows[0] && rows[0].created_at ? String(rows[0].created_at) : null;
    const lastMs = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
    const observed = Number.isFinite(lastMs) && Date.now() - lastMs >= 0 && Date.now() - lastMs <= 30 * 24 * 60 * 60 * 1000;
    const lastInboundByLine = { automation: null, main: null };
    for (const row of rows) {
      const ai = row?.ai && typeof row.ai === "object" && !Array.isArray(row.ai) ? row.ai : {};
      // Rows written before the second line existed are known automation-line messages.
      const line = String(ai.quoLine || "automation").trim().toLowerCase();
      if ((line === "automation" || line === "main") && !lastInboundByLine[line] && row?.created_at) {
        lastInboundByLine[line] = String(row.created_at);
      }
    }
    return {
      schema: true,
      observed,
      lastInboundAt,
      observedLines: { automation: !!lastInboundByLine.automation, main: !!lastInboundByLine.main },
      lastInboundByLine,
    };
  } catch { return empty; }
}
const SMS_AI_HOURLY_CAP = 30;
const E164 = /^\+[1-9]\d{7,14}$/;
const digits = (s) => String(s || "").replace(/\D/g, "");
const last10 = (s) => digits(s).slice(-10);
const toE164 = (value) => {
  const raw = String(value == null ? "" : value).trim();
  if (raw.startsWith("+")) return `+${raw.slice(1).replace(/\D/g, "")}`;
  const d = digits(raw);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d ? `+${d}` : "";
};
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").slice(0, n).trim();
const fmtPhone = (p) => { const d = last10(p); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || ""); };

const activeTeamMember = (member) => {
  if (!member || String(member.role || "").trim().toLowerCase() === "owner") return false;
  if (String(member.active ?? "true").trim().toLowerCase() === "false") return false;
  if (String(member.disabled ?? "false").trim().toLowerCase() === "true") return false;
  return !["disabled", "inactive", "revoked"].includes(String(member.status || "").trim().toLowerCase());
};

// A device token is bound to the team-member id during push registration. Keep the audience
// private-by-default and line-specific: the shared automation/staff line and the owner's ported
// main line have separate grants. Owners are notified through pushOwner, never duplicated here.
export function inboundTextStaffKeys(team, quoLine) {
  const capability = quoLine === "main" ? "commsMainLine" : quoLine === "automation" ? "commsTextInbox" : "";
  if (!capability || !Array.isArray(team)) return [];
  return [...new Set(team
    .filter((member) => activeTeamMember(member) && memberHasCapability(member, capability))
    .map((member) => String(member.id || "").trim())
    .filter(Boolean))];
}

async function notifyInboundText({ client, matches, fromPhone, text, quoLine, eventId, remaining, targets = { owner: true, staff: true } }) {
  const sender = client?.name || fmtPhone(fromPhone) || "Unknown number";
  const title = client
    ? `Text from ${client.name}`
    : matches.length > 1
      ? `Text needs review: ${sender}`
      : `New text from ${sender}`;
  const body = text.slice(0, 180) || "Open Comms → Inbox to review this text.";
  const sendWindow = () => Math.max(250, Math.min(1400, remaining(500)));
  const opts = { collapseId: `sms-${eventId}`, timeoutMs: sendWindow() };
  const staffCapability = quoLine === "main" ? "commsMainLine" : quoLine === "automation" ? "commsTextInbox" : "";

  if (!pushConfigured()) {
    const unavailable = { ok: false, skipped: "apns not configured" };
    return {
      owner: targets.owner ? unavailable : { ok: true, skipped: "owner alert already completed" },
      staff: targets.staff ? unavailable : { ok: true, skipped: "staff alerts already completed" },
    };
  }

  // Read the shared delivery gate once for this event and pass the exact same snapshot to every
  // audience helper. This avoids one Supabase read per staff member and keeps Test Mode decisions
  // consistent across the whole fan-out.
  const stateWindow = Math.max(100, Math.min(700, remaining(1700)));
  const [emailRun, teamRun] = await Promise.all([
    settleWithin(readAppStateVersioned("sps_email"), stateWindow),
    targets.staff
      ? settleWithin(readAppStateVersioned("sps_team"), stateWindow)
      : Promise.resolve({ completed: true, value: { exists: true, value: [] } }),
  ]);
  const email = emailRun.completed && !emailRun.error && emailRun.value?.exists && emailRun.value.value && typeof emailRun.value.value === "object" && !Array.isArray(emailRun.value.value)
    ? emailRun.value.value
    : null;
  const team = teamRun.completed && !teamRun.error && teamRun.value?.exists && Array.isArray(teamRun.value.value)
    ? teamRun.value.value
    : null;

  // `inbound_text` applies to every text, not only clients or AI-confirmed leads. Audience helpers
  // never throw; their explicit result decides whether the durable webhook can return 2xx or asks
  // Quo for a retry.
  const ownerPromise = targets.owner
    ? email
      ? pushOwner("inbound_text", title, body, INBOUND_TEXT_PUSH_LINK, { ...opts, email, ...(targets.staff && team ? { team } : {}) })
      : Promise.resolve({ ok: false, error: "notification settings are temporarily unavailable" })
    : Promise.resolve({ ok: true, skipped: "owner alert already completed" });

  const staffPromise = targets.staff ? (async () => {
    if (!email) return { ok: false, error: "notification settings are temporarily unavailable" };
    if (!team) return { ok: false, skipped: "team permissions unavailable — staff held" };
    const staffKeys = inboundTextStaffKeys(team, quoLine);
    if (!staffKeys.length) return { ok: true, sent: 0, skipped: "no authorized staff for this line" };
    const results = await Promise.all(staffKeys.map((staffKey) => pushStaff(staffKey, title, body, INBOUND_TEXT_PUSH_LINK, {
      ...opts,
      email,
      team,
      requiredCapability: staffCapability,
      timeoutMs: sendWindow(),
    })));
    return { ok: results.every((result) => result?.ok !== false), recipients: staffKeys.length, results };
  })() : Promise.resolve({ ok: true, skipped: "staff alerts already completed" });

  const [owner, staff] = await Promise.all([ownerPromise, staffPromise]);
  return { owner, staff };
}

// Quo expects a 2xx in under ten seconds. These bounds keep the durable insert on the critical
// path and let optional AI/push work consume only the time that remains.
const WEBHOOK_BUDGET_MS = 8200;
function settleWithin(promise, ms) {
  const wait = Math.max(1, Number(ms) || 1);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish({ completed: false, timeout: true }), wait);
    Promise.resolve(promise).then(
      (value) => finish({ completed: true, value }),
      (error) => finish({ completed: true, error }),
    );
  });
}
async function timedFetch(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, Number(ms) || 1));
  try { return await fetch(url, { ...(options || {}), signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}
async function insertInboxOnce(row, timeoutMs) {
  const response = await timedFetch(`${SUPABASE_URL}/rest/v1/sps_inbox?on_conflict=id`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify([row]),
  }, timeoutMs);
  if (!response.ok) return { ok: false, response, text: await response.text().catch(() => "") };
  const rows = await response.json().catch(() => []);
  const inserted = Array.isArray(rows) && rows.length > 0;
  return { ok: true, inserted, row: inserted ? rows[0] : null };
}

// Push delivery shares the existing inbox row so a successful durable insert can never make a
// failed Apple delivery unretryable. Quo retries 5xx webhook responses; this lease/ledger turns the
// duplicate event into a retry of only the unfinished owner/staff leg. APNs collapse ids suppress
// a second visible alert in the rare case delivery succeeds but the final ledger PATCH is lost.
const PUSH_DELIVERY_VERSION = 1;
const PUSH_RETRY_LEASE_MS = 30 * 1000;
const deliveryAi = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const deliveryMeta = (ai) => {
  const raw = deliveryAi(ai)._pushDelivery;
  if (!raw || Number(raw.v) !== PUSH_DELIVERY_VERSION) return null;
  const state = (value) => ["sending", "retry", "done"].includes(value) ? value : "retry";
  return {
    v: PUSH_DELIVERY_VERSION,
    owner: state(raw.owner),
    staff: state(raw.staff),
    attempts: Math.max(0, Number(raw.attempts) || 0),
    lastAttemptAt: String(raw.lastAttemptAt || ""),
    retryAfter: String(raw.retryAfter || ""),
  };
};
const withDelivery = (ai, delivery) => ({ ...deliveryAi(ai), _pushDelivery: delivery });
const freshDeliveryLease = (prior = null) => {
  const now = new Date();
  return {
    v: PUSH_DELIVERY_VERSION,
    owner: prior?.owner === "done" ? "done" : "sending",
    staff: prior?.staff === "done" ? "done" : "sending",
    attempts: Math.max(0, Number(prior?.attempts) || 0) + 1,
    lastAttemptAt: now.toISOString(),
    retryAfter: new Date(now.getTime() + PUSH_RETRY_LEASE_MS).toISOString(),
  };
};
const deliveryComplete = (delivery) => !!delivery && delivery.owner === "done" && delivery.staff === "done";
const retryDue = (delivery) => {
  const at = Date.parse(String(delivery?.retryAfter || ""));
  return !Number.isFinite(at) || at <= Date.now();
};
export const pushLegNeedsRetry = (result) => {
  // No APNs configuration is an operator setup state rather than a transient send. The text is
  // still durably visible in Comms and endlessly retrying the provider webhook cannot repair env.
  if (/apns (?:isn't|not) configured/i.test(String(result?.skipped || ""))) return false;
  if (Array.isArray(result.results)) return result.results.some(pushLegNeedsRetry);
  const failed = Math.max(0, Number(result.failed) || 0);
  const pruned = Math.max(0, Number(result.pruned) || 0);
  // A batch containing only permanently invalid tokens is complete once those rows are pruned.
  // `sendToTokens` reports ok:false when nothing was sent, so evaluate this before the ok flag.
  if (failed > 0 && failed === pruned) return false;
  if (!result || result.ok === false) return true;
  return failed > pruned;
};

async function readInboxDelivery(id, timeoutMs) {
  const response = await timedFetch(
    `${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(id)}&select=ai,kind`,
    { headers: sbHeaders() },
    timeoutMs,
  );
  if (!response.ok) return { ok: false, text: await response.text().catch(() => "") };
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) return { ok: false, text: "malformed inbox retry state" };
  return { ok: true, row: rows[0] || null };
}

async function patchInboxAi(id, ai, timeoutMs, expectedDelivery = null) {
  const expected = expectedDelivery
    ? `&ai=cs.${encodeURIComponent(JSON.stringify({ _pushDelivery: expectedDelivery }))}`
    : "";
  const response = await timedFetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(id)}${expected}&select=ai,kind`, {
    method: "PATCH",
    headers: { ...sbHeaders(), Prefer: "return=representation" },
    body: JSON.stringify({ ai }),
  }, timeoutMs);
  if (!response.ok) return { ok: false, text: await response.text().catch(() => "") };
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) return { ok: false, text: "malformed inbox update response" };
  return { ok: true, updated: rows.length > 0, row: rows[0] || null };
}

// Read the raw request body (bodyParser is off). Collect BUFFERS and concat once — string
// concatenation would corrupt a multi-byte char (emoji, accents — routine in SMS) split across
// stream chunks, which breaks both body_text and the HMAC digest.
function readRaw(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bytes += chunk.length;
      if (bytes <= maxBytes) chunks.push(chunk);
      else tooLarge = true;
    });
    req.on("end", () => resolve({ raw: Buffer.concat(chunks).toString("utf8"), tooLarge }));
    req.on("error", () => resolve({ raw: "", tooLarge: false }));
  });
}
// openphone-signature: "hmac;1;<ts_ms>;<base64sig>", HMAC-SHA256 of `ts + "." + rawBody`,
// key base64-decoded. Quo may rotate keys by sending comma-separated signature candidates.
function verifySig(raw, header, secretB64) {
  try {
    const key = Buffer.from(secretB64, "base64");
    if (!key.length) return false;
    const payloads = [raw];
    // Quo's Node example signs JSON.stringify(req.body). Raw requests are normally already compact,
    // but also try the canonical JSON representation so harmless transport whitespace cannot break it.
    try {
      const canonical = JSON.stringify(JSON.parse(raw));
      if (canonical !== raw) payloads.push(canonical);
    } catch { /* unparseable requests can still be checked against their exact raw bytes */ }
    const candidates = (Array.isArray(header) ? header : [header])
      .flatMap((value) => String(value || "").split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      const [scheme, version, ts, provided, ...extra] = candidate.split(";");
      const timestamp = Number(ts);
      if (scheme !== "hmac" || version !== "1" || extra.length || !provided || !Number.isFinite(timestamp)) continue;
      if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) continue;
      let supplied;
      try { supplied = Buffer.from(provided, "base64"); } catch { continue; }
      if (!supplied.length) continue;
      for (const payload of payloads) {
        const computed = crypto.createHmac("sha256", key).update(`${ts}.${payload}`, "utf8").digest();
        if (supplied.length === computed.length && crypto.timingSafeEqual(supplied, computed)) return true;
      }
    }
    return false;
  } catch { return false; }
}

const TRIAGE_SYSTEM = `You triage inbound TEXT MESSAGES to a pond/pool service business. Classify ONE text, reply STRICT JSON only:
{"kind":"lead"|"bill"|"other","confidence":0..1,"intent":"new_business"|"existing_service"|"billing"|"other","automated":true|false,"evidence":"exact short excerpt from the text","summary":"one plain sentence","lead":{"name":"","phone":"","service":"","message":""}}
"lead" = a real person explicitly asking about NEW service, a quote, an estimate, pricing, or availability. Existing-service updates, automated notices, spam, codes, and notifications are "other". "bill" = a payment/collections text the business owes. Evidence must quote the exact request/quote/new-service wording that proves the classification. Never invent details.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, openphone-signature");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") {
    const { schema, observed, lastInboundAt, observedLines, lastInboundByLine } = await inboxStatus();
    const automationLine = toE164(QUO_NUMBER);
    const mainLine = toE164(QUO_MAIN_NUMBER);
    const mainConfigured = !!String(QUO_MAIN_NUMBER || "").trim();
    const mainLineReady = !mainConfigured || (E164.test(mainLine) && mainLine !== automationLine);
    return res.status(200).json({ ok: true, configured: { key: !!KEY, ai: aiConfigured(), sig: !!SIGN_SECRET, line: E164.test(automationLine), mainConfigured, mainLine: E164.test(mainLine) && mainLine !== automationLine, duplicateLines: !!mainLine && mainLine === automationLine, schema, observed, observedLines, lastInboundAt, lastInboundByLine, push: pushConfigured(), ready: !!KEY && !!SIGN_SECRET && !!SERVICE_KEY && E164.test(automationLine) && mainLineReady && schema } });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!KEY || !SIGN_SECRET) return res.status(501).json({ error: "Inbound texting is not fully configured.", missingEnv: true });
  if (String((req.query || {}).key || "") !== KEY) return res.status(401).json({ error: "Unauthorized" });
  if (!SERVICE_KEY) return res.status(501).json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });
  if (!QUO_NUMBER) return res.status(501).json({ error: "Server missing QUO_PHONE_NUMBER", missingEnv: true });

  const { raw, tooLarge } = await readRaw(req);
  if (tooLarge) return res.status(413).json({ error: "Webhook payload is too large." });
  if (!verifySig(raw, req.headers["openphone-signature"], SIGN_SECRET)) {
    return res.status(401).json({ error: "Invalid webhook signature." });
  }
  let body; try { body = JSON.parse(raw || "{}"); } catch { return res.status(200).json({ ok: true, skipped: "unparseable" }); }

  // Storage/network failures return 5xx so Quo retries for up to three days; the unique inbox id
  // makes those retries harmless and prevents an inbound customer text from being acknowledged lost.
  const deadline = Date.now() + WEBHOOK_BUDGET_MS;
  const remaining = (reserve = 0) => Math.max(0, deadline - Date.now() - reserve);
  const out = { ok: true };
  try {
    if (body.type !== "message.received") return res.status(200).json({ ok: true, skipped: body.type || "missing event type" });
    const msg = (body.data && body.data.object) || {};
    // Fail SAFE: only ingest explicitly-incoming texts. Our OWN outbound sends ride this same
    // stream ("outgoing"), and a variant event that omits direction must NOT be re-ingested.
    if (String(msg.direction || "").toLowerCase() !== "incoming") return res.status(200).json({ ok: true, skipped: "not incoming" });
    // This workspace has more than one Quo line. Accept only the two explicitly configured SPS
    // lines and preserve which one received the text so replies use the same conversation line.
    const recipients = Array.isArray(msg.to) ? msg.to : (msg.to ? [msg.to] : []);
    if (!recipients.length) return res.status(200).json({ ok: true, skipped: "missing destination" });
    const acceptedLines = [
      { role: "automation", number: toE164(QUO_NUMBER) },
      { role: "main", number: toE164(QUO_MAIN_NUMBER) },
    ].filter((line, index, lines) => E164.test(line.number) && lines.findIndex((candidate) => candidate.number === line.number) === index);
    const matchedLine = acceptedLines.find((line) => recipients.some((recipient) => toE164(recipient) === line.number));
    if (!matchedLine) return res.status(200).json({ ok: true, skipped: "other business number" });
    const quoLine = matchedLine.role;
    const eventId = clean(body.id || msg.id, 80);
    if (!eventId) return res.status(200).json({ ok: true, skipped: "no id" });
    const id = `sms_${eventId}`;

    const fromPhone = clean(msg.from, 25);
    const mediaCount = Array.isArray(msg.media) ? msg.media.length : 0;
    const bodyText = clean(msg.body ?? msg.text, 3900);
    // Record that media arrived without persisting Quo's provider-hosted URLs. The private-media
    // rollout can import the bytes later; until then staff still see that a customer attached files.
    const mediaNote = mediaCount ? `[${mediaCount} media attachment${mediaCount === 1 ? "" : "s"}]` : "";
    const text = clean([bodyText, mediaNote].filter(Boolean).join(" "), 4000);
    if (!fromPhone) return res.status(200).json({ ok: true, skipped: "no from" });

    // Existing client? Keep this lookup bounded so a slow shared-state read cannot make Quo retry
    // a message that was actually stored. On timeout we store it unlinked for a human to review.
    const clientRead = await settleWithin(readAppStateVersioned("sps_clients"), Math.min(1400, remaining(5000)));
    const clientLookupOk = clientRead.completed && !clientRead.error && clientRead.value?.exists && Array.isArray(clientRead.value.value);
    const clients = clientLookupOk ? clientRead.value.value : [];
    const fp = last10(fromPhone);
    const matches = fp ? (Array.isArray(clients) ? clients : []).filter(c => last10(c.phone) === fp) : [];
    // Duplicate phone numbers make ownership ambiguous. Never attach a private text to whichever
    // client happens to appear first in a shared file.
    const client = matches.length === 1 ? matches[0] : null;

    let kind = client ? "client" : "other", ai = client
      ? { summary: `Text from client ${client.name}`, clientId: String(client.id), quoLine }
      : matches.length > 1
        ? { summary: "This phone number matches more than one client. Review it before replying.", quoLine }
        : clientLookupOk ? { quoLine } : {
          summary: clientRead.timeout
            ? "Client matching timed out. Review this text before replying."
            : "Client matching failed. Review this text before replying.",
          quoLine,
        };
    let delivery = freshDeliveryLease();
    ai = withDelivery(ai, delivery);

    const row = {
      id, channel: "sms", from_phone: fromPhone,
      from_name: client ? client.name : fmtPhone(fromPhone),
      from_email: fmtPhone(fromPhone), // display fallback for the inbox row
      subject: text.slice(0, 80) || "(text message)",
      body_text: text, body_html: "", message_id: eventId, kind, ai, lead_id: "", read: false, replied: false,
    };
    // Atomic inbox claim: `return=representation` tells us whether THIS invocation inserted the
    // row. A duplicate is acknowledged only after its delivery ledger is complete; otherwise it
    // becomes the provider-backed retry worker for whichever notification leg is unfinished.
    let claim;
    try {
      const insertWindow = Math.min(2500, remaining(3200));
      if (insertWindow < 100) throw new Error("webhook storage time budget exhausted");
      claim = await insertInboxOnce(row, insertWindow);
    } catch (error) {
      out.stored = false;
      out.error = String((error && error.message) || error || "inbox insert failed").slice(0, 200);
      return res.status(502).json(out);
    }
    if (!claim.ok) {
      const t = claim.text || "";
      out.stored = false;
      out.error = /relation .*sps_inbox|column|42P01|PGRST/i.test(t) ? "sps_inbox missing the channel/from_phone columns — run SMS-INBOX-MIGRATION.sql" : t.slice(0, 200);
      return res.status(502).json(out); // 5xx → Quo retries once the columns exist
    }
    let pushTargets = { owner: true, staff: true };
    if (!claim.inserted) {
      let existing;
      try {
        const readWindow = Math.min(1100, remaining(2600));
        if (readWindow < 100) throw new Error("webhook retry-state time budget exhausted");
        existing = await readInboxDelivery(id, readWindow);
      } catch (error) {
        out.stored = true;
        out.duplicate = true;
        out.error = String((error && error.message) || error || "inbox retry-state read failed").slice(0, 200);
        return res.status(502).json(out);
      }
      if (!existing.ok || !existing.row) {
        out.stored = true;
        out.duplicate = true;
        out.error = String(existing.text || "Stored text retry state is temporarily unavailable.").slice(0, 200);
        return res.status(502).json(out);
      }
      const priorDelivery = deliveryMeta(existing.row.ai);
      // Rows stored before this delivery ledger shipped remain ordinary historical duplicates. We
      // never replay old customer messages merely because they predate the notification feature.
      if (!priorDelivery || deliveryComplete(priorDelivery)) {
        return res.status(200).json({ ok: true, duplicate: true, notificationsComplete: !!priorDelivery });
      }
      if (!retryDue(priorDelivery)) {
        return res.status(503).json({ ok: false, stored: true, duplicate: true, notificationRetryPending: true });
      }
      const retryLease = freshDeliveryLease(priorDelivery);
      let retryClaim;
      try {
        const patchWindow = Math.min(1000, remaining(2100));
        if (patchWindow < 100) throw new Error("webhook retry-claim time budget exhausted");
        retryClaim = await patchInboxAi(id, withDelivery(existing.row.ai, retryLease), patchWindow, priorDelivery);
      } catch (error) {
        out.stored = true;
        out.duplicate = true;
        out.error = String((error && error.message) || error || "notification retry claim failed").slice(0, 200);
        return res.status(502).json(out);
      }
      if (!retryClaim.ok) {
        out.stored = true;
        out.duplicate = true;
        out.error = String(retryClaim.text || "notification retry claim failed").slice(0, 200);
        return res.status(502).json(out);
      }
      if (!retryClaim.updated) {
        // Another invocation renewed the exact JSONB lease first. A 5xx keeps Quo retrying without
        // issuing a second APNs request from this invocation.
        return res.status(503).json({ ok: false, stored: true, duplicate: true, notificationRetryPending: true });
      }
      delivery = retryLease;
      ai = withDelivery(existing.row.ai, delivery);
      kind = clean(existing.row.kind, 30) || kind;
      pushTargets = { owner: delivery.owner !== "done", staff: delivery.staff !== "done" };
      out.duplicate = true;
      out.notificationRetry = true;
    }
    out.stored = true; out.kind = kind; out.line = quoLine;

    // Notification delivery is deliberately AFTER the durable inbox claim and BEFORE optional AI.
    // Every inbound text now attempts an owner alert, including unknown numbers, ambiguous client
    // matches, bills, and ordinary non-leads. Staff are derived from the protected team state and
    // only receive the line they were explicitly granted; pushStaff preserves the Test Mode hold.
    const pushRun = await settleWithin(
      notifyInboundText({ client, matches, fromPhone, text, quoLine, eventId, remaining, targets: pushTargets }),
      Math.min(3100, remaining(1000)),
    );
    const pushResult = pushRun.completed && !pushRun.error
      ? pushRun.value
      : {
        owner: pushTargets.owner ? { ok: false, error: pushRun.timeout ? "webhook response time budget" : "push attempt failed" } : { ok: true, skipped: "owner alert already completed" },
        staff: pushTargets.staff ? { ok: false, error: pushRun.timeout ? "webhook response time budget" : "push attempt failed" } : { ok: true, skipped: "staff alerts already completed" },
      };
    out.push = pushResult;

    const ownerRetry = pushTargets.owner && pushLegNeedsRetry(pushResult?.owner);
    const staffRetry = pushTargets.staff && pushLegNeedsRetry(pushResult?.staff);
    const notificationsPending = ownerRetry || staffRetry;
    const now = new Date();
    const nextDelivery = {
      ...delivery,
      owner: pushTargets.owner ? (ownerRetry ? "retry" : "done") : delivery.owner,
      staff: pushTargets.staff ? (staffRetry ? "retry" : "done") : delivery.staff,
      retryAfter: notificationsPending ? new Date(now.getTime() + PUSH_RETRY_LEASE_MS).toISOString() : "",
    };
    const nextDeliveryAi = withDelivery(ai, nextDelivery);
    let deliveryPatch;
    try {
      const patchWindow = Math.min(1000, remaining(750));
      if (patchWindow < 100) throw new Error("webhook delivery-state time budget exhausted");
      deliveryPatch = await patchInboxAi(id, nextDeliveryAi, patchWindow, delivery);
    } catch (error) {
      out.error = String((error && error.message) || error || "notification delivery-state update failed").slice(0, 200);
      return res.status(502).json(out);
    }
    if (!deliveryPatch.ok || !deliveryPatch.updated) {
      out.error = String(deliveryPatch.text || "notification delivery-state update failed").slice(0, 200);
      return res.status(502).json(out);
    }
    delivery = nextDelivery;
    ai = nextDeliveryAi;
    out.notificationDelivery = { owner: delivery.owner, staff: delivery.staff };
    if (notificationsPending) {
      out.ok = false;
      out.notificationRetryPending = true;
      return res.status(502).json(out);
    }

    // Optional triage runs only after the durable atomic claim. It is capped separately from email
    // and skipped whenever the webhook's response budget is getting tight.
    if (!client && matches.length === 0 && clientLookupOk && aiConfigured() && remaining(2600) > 250) {
      const hourKey = new Date().toISOString().slice(0, 13);
      const budgetRun = await settleWithin(mutateAppState("sps_inbound_ai_budget_sms", (current) => {
        const budget = current && typeof current === "object" && !Array.isArray(current) ? current : {};
        const usedN = budget.h === hourKey ? (Number(budget.n) || 0) : 0;
        if (usedN >= SMS_AI_HOURLY_CAP) return NO_APP_STATE_CHANGE;
        return { ...budget, h: hourKey, n: usedN + 1 };
      }), Math.min(1000, remaining(2300)));
      const underBudget = budgetRun.completed && !budgetRun.error && !!budgetRun.value?.changed;
      if (underBudget && remaining(1500) > 250) {
        const triageRun = await settleWithin(
          callClaude({ system: TRIAGE_SYSTEM, content: `From: ${fromPhone}\n\n${text}`, maxTokens: 400, temperature: 0 }),
          Math.min(2400, remaining(1400)),
        );
        const j = triageRun.completed && !triageRun.error ? extractJson(triageRun.value) : null;
        if (j && ["lead", "bill", "other"].includes(j.kind) && remaining(900) > 100) {
          let nextKind = j.kind;
          let nextAi = { ...j, quoLine, _pushDelivery: delivery };
          if (j.kind === "lead") {
            const verdict = assessInboundLead({ channel: "sms", from_phone: fromPhone, body_text: text, ai: j }, clients);
            nextKind = verdict.eligible ? "lead" : verdict.kind;
            if (!verdict.eligible) nextAi = { ...j, quoLine, _pushDelivery: delivery, autoLead: false, leadRejectedReason: verdict.reason, ...(verdict.client ? { clientId: String(verdict.client.id) } : {}) };
          }
          try {
            const patch = await timedFetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(id)}`, {
              method: "PATCH",
              headers: { ...sbHeaders(), Prefer: "return=minimal" },
              body: JSON.stringify({ kind: nextKind, ai: nextAi }),
            }, Math.min(800, remaining(700)));
            if (patch.ok) { ai = nextAi; kind = nextKind; out.kind = kind; out.triaged = true; }
          } catch (_) { out.triaged = false; }
        }
      }
    }

  } catch (e) {
    out.ok = false; out.error = String((e && e.message) || e);
    return res.status(500).json(out);
  }
  return res.status(200).json(out);
}
