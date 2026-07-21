// api/_push.js — shared APNs push sender (Build 27 notifications).
//
// One helper every push rides through: owner alerts (new lead, invoice paid, tech note,
// reports), client notices (new message / invoice / visit report via the portal-message
// webhook), and staff notices (new stop assigned). Sends direct to Apple (HTTP/2 + ES256
// JWT from the APNs .p8 auth key) — no Firebase, no third-party SDK.
//
// SHIPS DARK until the APNs env vars are set (same posture as _ai.js / plaid):
//   APNS_KEY_ID       — from the APNs Auth Key (.p8) in the Apple Developer account
//   APNS_TEAM_ID      — Apple team id (JASPHFVN38)
//   APNS_PRIVATE_KEY  — the .p8 contents (PEM; newlines preserved or \n-escaped)
//   APNS_BUNDLE_ID    — optional, defaults to com.stonepropertysolutions.app (the apns-topic)
//   APNS_HOST         — optional, defaults to https://api.push.apple.com. Set to
//                       https://api.sandbox.push.apple.com when testing an Xcode debug build
//                       (debug builds mint sandbox tokens; TestFlight/App Store = production).
// (Env names match supabase/functions/qb-payment-webhook/SETUP.md — the dormant Edge-Function
// prior art this supersedes; its ES256 JWT builder is lifted here nearly verbatim.)
//
// Tokens live in sps_push_tokens (service-role only, like plaid_tokens — see CLAUDE.md SQL):
//   token (pk) · user_email · user_key (team member id or client id) · role owner|staff|client
//   · platform · enabled · updated_at
// Registered by api/push/register.js; dead tokens (APNs 400 BadDeviceToken / 410 Unregistered)
// are pruned automatically on send.
//
// SAFETY: Test Mode (sps_email.testMode.on) restricts every push to OWNER-role tokens only —
// clients and staff can never be pushed while the app is under test rules. Owner pushes also
// honor the per-event Push toggles in Comms → Settings (sps_email.notify.events[key].push).
// All sends are best-effort: helpers never throw, callers treat them like logComm.

import http2 from "node:http2";
import { memberHasCapability } from "./_staff-auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KEY_ID    = process.env.APNS_KEY_ID;
const TEAM_ID   = process.env.APNS_TEAM_ID;
const P8        = process.env.APNS_PRIVATE_KEY;
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.stonepropertysolutions.app";
const APNS_HOST = process.env.APNS_HOST || "https://api.push.apple.com";

export const pushConfigured = () => !!(KEY_ID && TEAM_ID && P8 && SERVICE_KEY);

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const parseVal = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
async function fetchWithin(url, options = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(100, Number(timeoutMs) || 4000));
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}
async function sbGet(key, fallback) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
    if (!r.ok) return fallback;
    const rows = await r.json().catch(() => []);
    const v = rows && rows[0] ? parseVal(rows[0].value) : null;
    return v == null ? fallback : v;
  } catch { return fallback; }
}

function parseStoredValue(value) {
  let parsed = value;
  // app_state has existed as both JSONB and a JSON string inside JSONB. Match the authorization
  // helpers' tolerant reader so a harmless legacy encoding never becomes a role bypass.
  for (let i = 0; i < 2 && typeof parsed === "string"; i += 1) {
    try { parsed = JSON.parse(parsed); } catch { break; }
  }
  return parsed;
}

async function getCurrentTeam(opts = {}, timeoutMs = 4000) {
  if (Object.prototype.hasOwnProperty.call(opts, "team")) {
    if (!Array.isArray(opts.team)) throw new Error("team roster is missing or malformed");
    return opts.team;
  }
  const r = await fetchWithin(
    `${SUPABASE_URL}/rest/v1/app_state?key=eq.sps_team&select=value`,
    { headers: sbHeaders() },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`team roster lookup failed (${r.status})`);
  const rows = await r.json().catch(() => null);
  const team = Array.isArray(rows) && rows.length === 1 ? parseStoredValue(rows[0]?.value) : null;
  if (!Array.isArray(team)) throw new Error("team roster is missing or malformed");
  return team;
}

const cleanRosterEmail = (value) => String(value || "").trim().toLowerCase();
const cleanRosterRole = (value) => String(value || "field").trim().toLowerCase();
const activeRosterMember = (member) => {
  if (!member || typeof member !== "object") return false;
  if (String(member.active ?? "true").trim().toLowerCase() === "false") return false;
  if (String(member.disabled ?? "false").trim().toLowerCase() === "true") return false;
  return !["disabled", "inactive", "revoked"].includes(String(member.status || "").trim().toLowerCase());
};

function rosterMemberKey(member) {
  const id = String(member?.id ?? "").trim();
  return id || cleanRosterEmail(member?.email);
}

// Exported for focused, transport-free security tests. This is the last gate before APNs: a role
// copied into sps_push_tokens is only a registration hint, never lasting authorization.
export function filterCurrentTeamPushTokens(rows, team, {
  audience = "",
  staffKey = "",
  requiredCapability = "",
} = {}) {
  if (!Array.isArray(rows) || !Array.isArray(team)) return [];
  const active = team.filter(activeRosterMember);
  const wantedStaffKey = String(staffKey || "").trim();
  const capability = String(requiredCapability || "").trim();

  return rows.filter((row) => {
    if (!row || typeof row !== "object") return false;
    const tokenEmail = cleanRosterEmail(row.user_email);
    const tokenKey = String(row.user_key ?? "").trim();
    if (!tokenEmail || !tokenKey) return false;

    // Resolve by BOTH the verified email captured at registration and the stable roster key.
    // Duplicate active emails/keys are ambiguous and therefore fail closed.
    const matches = active.filter((member) => (
      cleanRosterEmail(member.email) === tokenEmail
      && rosterMemberKey(member) === tokenKey
    ));
    if (matches.length !== 1) return false;
    const member = matches[0];
    const currentRole = cleanRosterRole(member.role);

    if (audience === "owner") {
      return row.role === "owner" && currentRole === "owner";
    }
    if (audience !== "staff") return false;
    if (row.role !== "staff" || currentRole === "owner") return false;
    if (!wantedStaffKey || rosterMemberKey(member) !== wantedStaffKey) return false;
    // Every production pushStaff caller must name the exact action/line capability. A future call
    // site that forgets this argument fails closed instead of silently broadening staff alerts.
    return !!capability && memberHasCapability(member, capability);
  });
}

// ── APNs JWT (ES256 via WebCrypto — Node 18+ has crypto.subtle) ────────────────────────────────
// Apple wants provider tokens reused for 20–60 min; cache and re-mint at 45.
let _jwt = { at: 0, v: "" };
function pemToBytes(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(b64, "base64"));
}
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function apnsJwt() {
  if (_jwt.v && Date.now() - _jwt.at < 45 * 60 * 1000) return _jwt.v;
  const header = { alg: "ES256", kid: KEY_ID };
  const payload = { iss: TEAM_ID, iat: Math.floor(Date.now() / 1000) };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await globalThis.crypto.subtle.importKey(
    "pkcs8", pemToBytes(P8.replace(/\\n/g, "\n")), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  _jwt = { at: Date.now(), v: `${signingInput}.${b64url(sig)}` };
  return _jwt.v;
}

// ── HTTP/2 transport — APNs refuses HTTP/1.1, and Node's fetch/undici won't speak h2, so this
// keeps one session per batch and runs the device posts through it. ──────────────────────────
function h2Session(origin, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const client = http2.connect(origin);
    const bail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.destroy(); } catch (_) {}
      resolve({ client: null, error: String((e && e.message) || e || "connect failed") });
    };
    const requested = Number(timeoutMs);
    const timer = setTimeout(
      () => bail("connect timeout"),
      Math.max(100, Math.min(8000, Number.isFinite(requested) ? requested : 8000)),
    );
    client.once("error", bail);
    client.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener("error", bail);
      // A mid-batch session error (GOAWAY / ECONNRESET) must never surface as an uncaught
      // exception. The send loop reports the failed batch explicitly so each caller can either
      // persist a retry or surface a safe error for its own delivery contract.
      client.on("error", () => {});
      resolve({ client });
    });
  });
}
function h2Post(client, path, headers, body, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let status = 0, data = "", settled = false;
    const req = client.request({ ":method": "POST", ":path": path, ...headers });
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, body: data, error });
    };
    const requested = Number(timeoutMs);
    const timer = setTimeout(() => { try { req.close(); } catch (_) {} done("timeout"); }, Math.max(100, Math.min(10000, Number.isFinite(requested) ? requested : 10000)));
    req.on("response", (h) => { status = h[":status"] || 0; });
    req.on("data", (c) => { data += c; });
    req.on("end", () => done());
    req.on("error", (e) => done(String((e && e.message) || e)));
    req.end(body);
  });
}

// ── Token store ────────────────────────────────────────────────────────────────────────────────
async function getTokens(filter, { strict = false, timeoutMs = 4000 } = {}) {
  try {
    const r = await fetchWithin(`${SUPABASE_URL}/rest/v1/sps_push_tokens?${filter}&enabled=eq.true&select=token,role,user_key,user_email`, { headers: sbHeaders() }, timeoutMs);
    if (!r.ok) {
      if (strict) throw new Error(`push token lookup failed (${r.status})`);
      return [];
    }
    const rows = await r.json().catch(() => null);
    if (!Array.isArray(rows)) {
      if (strict) throw new Error("push token lookup returned malformed data");
      return [];
    }
    return rows;
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}
async function pruneToken(token, timeoutMs = 1200) {
  try {
    const response = await fetchWithin(
      `${SUPABASE_URL}/rest/v1/sps_push_tokens?token=eq.${encodeURIComponent(token)}`,
      { method: "DELETE", headers: { ...sbHeaders(), Prefer: "return=representation" } },
      timeoutMs,
    );
    if (!response.ok) return false;
    const rows = await response.json().catch(() => null);
    // An empty representation is also confirmed: another invocation may have removed the same
    // token after this batch selected it. A malformed/non-2xx response remains retryable.
    return Array.isArray(rows);
  } catch { return false; }
}

// ── Core send: rows [{token}], msg {title, body, link, collapseId} ─────────────────────────────
async function sendToTokens(rows, msg, { timeoutMs = 0 } = {}) {
  if (!pushConfigured()) return { ok: false, skipped: "APNs isn't configured yet — add the APNS_* keys in Vercel." };
  if (!rows || !rows.length) return { ok: true, sent: 0, reason: "no registered devices" };
  if (rows.length > 100) return { ok: false, sent: 0, failed: rows.length, pruned: 0, error: "push audience exceeds the safe batch limit" };
  let jwt;
  try { jwt = await apnsJwt(); } catch (e) { return { ok: false, error: `APNs key problem: ${String((e && e.message) || e)}` }; }
  const deadline = Number(timeoutMs) > 0 ? Date.now() + Math.max(250, Number(timeoutMs)) : 0;
  const timeLeft = (fallback) => deadline ? Math.max(0, deadline - Date.now()) : fallback;
  const { client, error } = await h2Session(APNS_HOST, timeLeft(8000));
  if (!client) return { ok: false, error };
  const payload = JSON.stringify({
    aps: { alert: { title: String(msg.title || "").slice(0, 120), body: String(msg.body || "").slice(0, 220) }, sound: "default" },
    // Capacitor also forwards local UNUserNotificationCenter alerts (including arrival detection)
    // through its push listeners. This signed-server marker lets the app count only real APNs
    // deliveries in notification diagnostics instead of falsely certifying a local alert.
    spsRemote: true,
    ...(msg.link ? { link: String(msg.link) } : {}),
  });
  const headers = {
    authorization: `bearer ${jwt}`,
    "apns-topic": BUNDLE_ID,
    "apns-push-type": "alert",
    "apns-priority": "10",
    ...(msg.collapseId ? { "apns-collapse-id": String(msg.collapseId).slice(0, 60) } : {}),
    "content-type": "application/json",
  };
  let sent = 0, failed = 0, pruned = 0;
  try {
    const batch = rows;
    for (let index = 0; index < batch.length; index += 1) {
      const row = batch[index];
      const remaining = timeLeft(10000);
      if (deadline && remaining < 100) {
        failed += batch.length - index;
        break;
      }
      let r;
      try {
        r = await h2Post(client, `/3/device/${row.token}`, headers, payload, remaining);
      } catch (error) {
        r = { status: 0, body: "", error: String((error && error.message) || error) };
      }
      if (r.status === 200) { sent++; continue; }
      failed++;
      // 410 Unregistered (app deleted) → always drop. BadDeviceToken is ALSO what APNs returns
      // for an environment mismatch, so it only prunes when we're on the production host —
      // otherwise pointing APNS_HOST at sandbox for a debug test would wipe every real token.
      const reason = (() => { try { return JSON.parse(r.body || "{}").reason || ""; } catch { return ""; } })();
      const prodHost = APNS_HOST === "https://api.push.apple.com";
      if (r.status === 410 || reason === "Unregistered" || reason === "DeviceTokenNotForTopic" || (reason === "BadDeviceToken" && prodHost)) {
        const pruneWindow = deadline ? Math.max(100, Math.min(800, timeLeft(800))) : 1200;
        if (await pruneToken(row.token, pruneWindow)) pruned++;
      }
    }
  } finally {
    try { client.close(); } catch (_) {}
  }
  return { ok: sent > 0 || failed === 0, sent, failed, pruned };
}

// Registration diagnostics are scoped by the email from a VERIFIED Supabase identity. These
// helpers never accept a role, team id, client id, or raw token from the request, so callers
// cannot inspect or push another account's devices. The strict lookup keeps an unavailable token
// store from being misreported as "no devices".
const cleanPushEmail = (value) => String(value || "").trim().toLowerCase();
const tokenLookupWindow = (sendTimeoutMs, fallback = 4000) => {
  const n = Number(sendTimeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.max(250, Math.min(1200, Math.floor(n * 0.45))) : fallback;
};

const cleanPushPlatform = (value) => {
  const platform = String(value || "").trim();
  return /^ios:[A-Za-z0-9._~-]{16,128}$/.test(platform) ? platform : "";
};

export async function getUserPushStatus(verifiedEmail, { platform = "" } = {}) {
  const email = cleanPushEmail(verifiedEmail);
  if (!email) throw new Error("verified email is required");
  const scopedPlatform = cleanPushPlatform(platform);
  const filter = `user_email=eq.${encodeURIComponent(email)}${scopedPlatform ? `&platform=eq.${encodeURIComponent(scopedPlatform)}` : ""}`;
  const rows = await getTokens(filter, { strict: true, timeoutMs: 3500 });
  return {
    configured: pushConfigured(),
    bound: rows.length > 0,
    deviceCount: rows.length,
  };
}

// Deliberately bypasses the global Test Mode audience gate: this is a benign, explicit self-test
// requested by the signed-in user and it can reach only that same user's enabled device rows.
// APNs failures and invalid-token pruning still flow through the one shared sender above.
export async function pushUserSelfTest(verifiedEmail, { platform = "" } = {}) {
  try {
    if (!pushConfigured()) return { ok: false, skipped: "apns not configured" };
    const email = cleanPushEmail(verifiedEmail);
    if (!email) return { ok: false, error: "verified email is required" };
    const scopedPlatform = cleanPushPlatform(platform);
    const filter = `user_email=eq.${encodeURIComponent(email)}${scopedPlatform ? `&platform=eq.${encodeURIComponent(scopedPlatform)}` : ""}`;
    const rows = await getTokens(filter, { strict: true, timeoutMs: 3000 });
    return await sendToTokens(rows, {
      title: "SPS Way notifications are working",
      body: "This device is ready for SPS Way alerts.",
      collapseId: "sps-push-self-test",
    }, { timeoutMs: 12000 });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

// ── Audience helpers — every caller goes through one of these three ───────────────────────────
// opts.email: pass an already-fetched sps_email object to skip the re-read (crons have it).
// Returns NULL when the settings read fails — pushClient/pushStaff treat that as HELD (fail
// closed: a transient app_state read error must never disable the Test Mode gate).

async function getEmailCfg(opts) {
  const cfg = opts && Object.prototype.hasOwnProperty.call(opts, "email")
    ? opts.email
    : await sbGet("sps_email", null);
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)
    || !cfg.testMode || typeof cfg.testMode !== "object" || Array.isArray(cfg.testMode)) return null;
  const rawOn = cfg.testMode.on;
  const onText = typeof rawOn === "string" ? rawOn.trim().toLowerCase() : "";
  if (rawOn !== true && rawOn !== false && onText !== "true" && onText !== "false") return null;
  return {
    ...cfg,
    testMode: {
      ...cfg.testMode,
      on: rawOn === true || onText === "true",
      liveClientIds: Array.isArray(cfg.testMode.liveClientIds) ? cfg.testMode.liveClientIds : [],
    },
  };
}

// Which role does a VERIFIED email hold? team member → owner|staff, client match → client,
// else "". Used by send-push to role-gate callers (register.js keeps its own copy because it
// also needs the member/client id).
export async function resolveCallerRole(emailKey) {
  const key = String(emailKey || "").trim().toLowerCase();
  if (!key) return "";
  const team = await sbGet("sps_team", []);
  const member = (Array.isArray(team) ? team : []).find(m => String(m.email || "").trim().toLowerCase() === key);
  if (member) return member.role === "owner" ? "owner" : "staff";
  const clients = await sbGet("sps_clients", []);
  const client = (Array.isArray(clients) ? clients : []).find(c => String(c.email || "").trim().toLowerCase() === key);
  return client ? "client" : "";
}

// Owner devices. eventKey (optional) honors the per-event Push toggle in Comms → Settings —
// default ON (push !== false) so new event types notify until the owner turns them off.
export async function pushOwner(eventKey, title, body, link, opts = {}) {
  try {
    if (!pushConfigured()) return { ok: false, skipped: "apns not configured" };
    const email = await getEmailCfg(opts);
    if (email == null) return { ok: false, retryable: true, error: "notification settings are temporarily unavailable" };
    const events = email.notify && email.notify.events ? email.notify.events : {};
    // New installs have a dedicated inbound-text switch. Older saved settings predate that key, so
    // inherit their client-message opt-out until the new preference is explicitly saved.
    const evCfg = eventKey === "inbound_text"
      ? (events.inbound_text || events.client_message || null)
      : (eventKey ? events[eventKey] : null);
    if (evCfg && evCfg.push === false) return { ok: true, skipped: `owner turned off push for ${eventKey}` };
    const lookupMs = tokenLookupWindow(opts.timeoutMs);
    const [rows, team] = await Promise.all([
      getTokens("role=eq.owner", { strict: true, timeoutMs: lookupMs }),
      getCurrentTeam(opts, lookupMs),
    ]);
    const authorizedRows = filterCurrentTeamPushTokens(rows, team, { audience: "owner" });
    return await sendToTokens(authorizedRows, { title, body, link, collapseId: opts.collapseId }, { timeoutMs: opts.timeoutMs });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// One client's devices. Test Mode on → skipped (clients are never pushed under test rules) —
// EXCEPT pilot-live clients (testMode.liveClientIds), who get real pushes with everything else.
export async function pushClient(clientId, title, body, link, opts = {}) {
  try {
    if (!pushConfigured()) return { ok: false, skipped: "apns not configured" };
    if (clientId == null || clientId === "") return { ok: false, skipped: "no client id" };
    const email = await getEmailCfg(opts);
    if (email == null) return { ok: true, held: true, skipped: "settings unreadable — held (fail closed)" };
    const live = !!(email.testMode && (email.testMode.liveClientIds || []).map(String).includes(String(clientId)));
    if (email.testMode && email.testMode.on && !live) return { ok: true, held: true, skipped: "test mode — client pushes held" };
    const rows = await getTokens(`role=eq.client&user_key=eq.${encodeURIComponent(String(clientId))}`, { strict: true, timeoutMs: tokenLookupWindow(opts.timeoutMs) });
    return await sendToTokens(rows, { title, body, link, collapseId: opts.collapseId }, { timeoutMs: opts.timeoutMs });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// One staff member's devices (team member id). Test Mode on → held, same as clients.
export async function pushStaff(staffKey, title, body, link, opts = {}) {
  try {
    if (!pushConfigured()) return { ok: false, skipped: "apns not configured" };
    if (staffKey == null || staffKey === "") return { ok: false, skipped: "no staff id" };
    const email = await getEmailCfg(opts);
    if (email == null) return { ok: true, held: true, skipped: "settings unreadable — held (fail closed)" };
    if (email.testMode && email.testMode.on) return { ok: true, held: true, skipped: "test mode — staff pushes held" };
    if (!String(opts.requiredCapability || "").trim()) return { ok: false, error: "staff push capability is required" };
    const lookupMs = tokenLookupWindow(opts.timeoutMs);
    const [rows, team] = await Promise.all([
      getTokens(`role=eq.staff&user_key=eq.${encodeURIComponent(String(staffKey))}`, { strict: true, timeoutMs: lookupMs }),
      getCurrentTeam(opts, lookupMs),
    ]);
    const authorizedRows = filterCurrentTeamPushTokens(rows, team, {
      audience: "staff",
      staffKey: String(staffKey),
      requiredCapability: opts.requiredCapability,
    });
    return await sendToTokens(authorizedRows, { title, body, link, collapseId: opts.collapseId }, { timeoutMs: opts.timeoutMs });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
