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
async function sbGet(key, fallback) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
    if (!r.ok) return fallback;
    const rows = await r.json().catch(() => []);
    const v = rows && rows[0] ? parseVal(rows[0].value) : null;
    return v == null ? fallback : v;
  } catch { return fallback; }
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
function h2Session(origin) {
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
    const timer = setTimeout(() => bail("connect timeout"), 8000);
    client.once("error", bail);
    client.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener("error", bail);
      // A mid-batch session error (GOAWAY / ECONNRESET) must NEVER surface as an uncaught
      // exception — that would 500 the invocation and break the webhooks' always-200 contract
      // (Supabase would retry and re-fire the SMS/email that already succeeded). With this
      // swallow handler the send loop just sees per-request failures instead.
      client.on("error", () => {});
      resolve({ client });
    });
  });
}
function h2Post(client, path, headers, body) {
  return new Promise((resolve) => {
    let status = 0, data = "";
    const req = client.request({ ":method": "POST", ":path": path, ...headers });
    const done = (error) => resolve({ status, body: data, error });
    const timer = setTimeout(() => { try { req.close(); } catch (_) {} done("timeout"); }, 10000);
    req.on("response", (h) => { status = h[":status"] || 0; });
    req.on("data", (c) => { data += c; });
    req.on("end", () => { clearTimeout(timer); done(); });
    req.on("error", (e) => { clearTimeout(timer); done(String((e && e.message) || e)); });
    req.end(body);
  });
}

// ── Token store ────────────────────────────────────────────────────────────────────────────────
async function getTokens(filter) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_push_tokens?${filter}&enabled=eq.true&select=token,role,user_key`, { headers: sbHeaders() });
    if (!r.ok) return [];
    return (await r.json().catch(() => [])) || [];
  } catch { return []; }
}
async function pruneToken(token) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/sps_push_tokens?token=eq.${encodeURIComponent(token)}`, { method: "DELETE", headers: sbHeaders() });
  } catch { /* best-effort */ }
}

// ── Core send: rows [{token}], msg {title, body, link, collapseId} ─────────────────────────────
async function sendToTokens(rows, msg) {
  if (!pushConfigured()) return { ok: false, skipped: "APNs isn't configured yet — add the APNS_* keys in Vercel." };
  if (!rows || !rows.length) return { ok: true, sent: 0, reason: "no registered devices" };
  let jwt;
  try { jwt = await apnsJwt(); } catch (e) { return { ok: false, error: `APNs key problem: ${String((e && e.message) || e)}` }; }
  const { client, error } = await h2Session(APNS_HOST);
  if (!client) return { ok: false, error };
  const payload = JSON.stringify({
    aps: { alert: { title: String(msg.title || "").slice(0, 120), body: String(msg.body || "").slice(0, 220) }, sound: "default" },
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
  for (const row of rows.slice(0, 100)) {
    const r = await h2Post(client, `/3/device/${row.token}`, headers, payload);
    if (r.status === 200) { sent++; continue; }
    failed++;
    // 410 Unregistered (app deleted) → always drop. BadDeviceToken is ALSO what APNs returns
    // for an environment mismatch, so it only prunes when we're on the production host —
    // otherwise pointing APNS_HOST at sandbox for a debug test would wipe every real token.
    const reason = (() => { try { return JSON.parse(r.body || "{}").reason || ""; } catch { return ""; } })();
    const prodHost = APNS_HOST === "https://api.push.apple.com";
    if (r.status === 410 || reason === "Unregistered" || reason === "DeviceTokenNotForTopic" || (reason === "BadDeviceToken" && prodHost)) {
      await pruneToken(row.token); pruned++;
    }
  }
  try { client.close(); } catch (_) {}
  return { ok: sent > 0 || failed === 0, sent, failed, pruned };
}

// ── Audience helpers — every caller goes through one of these three ───────────────────────────
// opts.email: pass an already-fetched sps_email object to skip the re-read (crons have it).
// Returns NULL when the settings read fails — pushClient/pushStaff treat that as HELD (fail
// closed: a transient app_state read error must never disable the Test Mode gate).

async function getEmailCfg(opts) {
  if (opts && opts.email) return opts.email;
  return await sbGet("sps_email", null);
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
    const evCfg = eventKey && email && email.notify && email.notify.events ? email.notify.events[eventKey] : null;
    if (evCfg && evCfg.push === false) return { ok: true, skipped: `owner turned off push for ${eventKey}` };
    const rows = await getTokens("role=eq.owner");
    return await sendToTokens(rows, { title, body, link, collapseId: opts.collapseId });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// One client's devices. Test Mode on → skipped (clients are never pushed under test rules).
export async function pushClient(clientId, title, body, link, opts = {}) {
  try {
    if (!pushConfigured()) return { ok: false, skipped: "apns not configured" };
    if (clientId == null || clientId === "") return { ok: false, skipped: "no client id" };
    const email = await getEmailCfg(opts);
    if (email == null) return { ok: true, held: true, skipped: "settings unreadable — held (fail closed)" };
    if (email.testMode && email.testMode.on) return { ok: true, held: true, skipped: "test mode — client pushes held" };
    const rows = await getTokens(`role=eq.client&user_key=eq.${encodeURIComponent(String(clientId))}`);
    return await sendToTokens(rows, { title, body, link, collapseId: opts.collapseId });
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
    const rows = await getTokens(`role=eq.staff&user_key=eq.${encodeURIComponent(String(staffKey))}`);
    return await sendToTokens(rows, { title, body, link, collapseId: opts.collapseId });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
