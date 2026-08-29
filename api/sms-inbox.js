// api/sms-inbox.js — staff-safe access to inbound Quo text messages only.
//
// This route intentionally does NOT expose email. Work email remains behind the owner-only
// api/inbox.js + Gmail bridge. Every request must first pass the Comms text-inbox capability;
// access to the main work line is a second, independent capability. The Supabase service role
// bypasses RLS, so this file applies the same line scope to reads AND mutations and re-reads every
// requested id before changing it.
//
// Historical SMS rows predate multi-line support and have no ai.quoLine. They could only have
// arrived on the automation line, so missing metadata retains that legacy classification. Any
// unexpected non-empty line value fails closed and is never returned or mutated here.

import { memberHasCapability, requireStaff } from "./_staff-auth.js";
import { mutateAppState, readAppStateVersioned } from "./_app-state.js";
import {
  parseTestRedirect,
  SMS_MEDIA_BUCKET,
  signPrivateSmsMedia,
  toSmsE164,
} from "./_sms-history.js";
import { mergeInboxConversationRows } from "../smsConversations.js";
import { summarizeActionableCommsRows } from "../commsPriority.js";

const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://ysqarusrewceezckawlo.supabase.co"
).replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const MAX_IDS = 200;
const MAX_ID_LENGTH = 120;
const VALID_ID = /^[A-Za-z0-9._:-]+$/;
const VALID_KINDS = new Set(["lead", "bill", "client", "other"]);
const SMS_THREAD_META_KEY = "sps_sms_thread_meta";
const MAX_THREAD_META = 2500;
const SMS_THREAD_PREFERENCES_TABLE = "sps_sms_thread_preferences";
const MAX_THREAD_PREFERENCES = 500;
const MAX_IDENTITY_IDS = 50;
const ACTIONABLE_SMS_FIELDS = [
  "id",
  "channel",
  "ai",
  "kind",
  "lead_id",
  "read",
  "from_phone",
  "body_text",
  "created_at",
  "sms_direction",
  "sms_line",
  "sms_peer_phone",
  "quo_conversation_id",
  "sms_status",
].join(",");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Authorization");
}

function serviceHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function parseStoredValue(value) {
  let parsed = value;
  for (let i = 0; i < 2 && typeof parsed === "string"; i += 1) {
    try { parsed = JSON.parse(parsed); } catch { break; }
  }
  return parsed;
}

function rowLine(row) {
  if (!row || row.channel !== "sms") return null;
  const storedLine = String(row.sms_line == null ? "" : row.sms_line).trim().toLowerCase();
  if (storedLine === "automation" || storedLine === "main") return storedLine;
  if (storedLine) return null;
  const ai = parseStoredValue(row.ai);
  if (ai != null && (typeof ai !== "object" || Array.isArray(ai))) return null;
  const raw = ai && typeof ai === "object"
    ? String(ai.quoLine == null ? "" : ai.quoLine).trim().toLowerCase()
    : "";
  if (!raw || raw === "automation") return "automation";
  if (raw === "main") return "main";
  return null;
}

function rowConversationPeer(row) {
  const redirected = parseTestRedirect(row?.body_text);
  return redirected?.intendedPeer || toSmsE164(row?.sms_peer_phone || row?.from_phone);
}

function sameConversation(row, { line, peer, providerId }) {
  if (!row || row.channel !== "sms" || rowLine(row) !== line) return false;
  const rowPeer = rowConversationPeer(row);
  // The normalized counterparty is the durable identity across legacy rows and newer Quo
  // metadata. Provider ids are a fallback only when neither row has a usable phone; trusting a
  // provider id over two different phones can join unrelated people into one employee-visible
  // thread.
  if (peer || rowPeer) return !!peer && rowPeer === peer;
  return !!providerId && String(row.quo_conversation_id || "").trim() === providerId;
}

function browserPeerPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function rowThreadKey(row) {
  const line = rowLine(row);
  const peer = browserPeerPhone(rowConversationPeer(row));
  if (line && peer) return `${line}|phone:${peer}`;
  const provider = String(row?.quo_conversation_id || "").trim();
  return line && provider && !parseTestRedirect(row?.body_text) ? `${line}|quo:${provider}` : "";
}

function canAccessThreadKey(threadKey, access) {
  const key = String(threadKey || "").trim();
  if (!key || key.length > 240) return false;
  const separator = key.indexOf("|");
  const line = separator > 0 ? key.slice(0, separator) : "";
  if (line === "automation" && !access.automation) return false;
  if (line === "main" && !access.main) return false;
  if (line !== "automation" && line !== "main") return false;
  return /^(phone:[0-9]{10}|quo:[A-Za-z0-9._:-]{1,160})$/.test(key.slice(separator + 1));
}

async function readThreadPreferences(userId, access) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${SMS_THREAD_PREFERENCES_TABLE}`
      + `?select=user_id,thread_key,pinned_at&user_id=eq.${encodeURIComponent(userId)}`
      + `&order=pinned_at.desc&limit=${MAX_THREAD_PREFERENCES}`,
    { headers: serviceHeaders() },
  );
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const missingTable = response.status === 404
      || ["42P01", "PGRST205"].includes(String(details?.code || "").toUpperCase());
    if (missingTable) return null;
    throw new Error(`text preference read failed (${response.status})`);
  }
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw new Error("text preference read returned invalid data");

  const preferences = {};
  for (const row of rows) {
    const threadKey = String(row?.thread_key || "");
    // The service role bypasses RLS. Re-check both the authenticated user id and the employee's
    // current line grant before returning even this small piece of personal UI state.
    if (String(row?.user_id || "") !== userId || !canAccessThreadKey(threadKey, access)) continue;
    preferences[threadKey] = {
      pinned: true,
      pinnedAt: String(row?.pinned_at || ""),
    };
  }
  return preferences;
}

async function setThreadPinned(userId, threadKey, pinned) {
  const userFilter = `user_id=eq.${encodeURIComponent(userId)}`;
  const threadFilter = `thread_key=eq.${encodeURIComponent(threadKey)}`;
  if (!pinned) {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/${SMS_THREAD_PREFERENCES_TABLE}`
        + `?${userFilter}&${threadFilter}&select=user_id,thread_key`,
      {
        method: "DELETE",
        headers: serviceHeaders({ Prefer: "return=representation" }),
      },
    );
    if (!response.ok) return null;
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) return null;
    // No returned row means this conversation was already unpinned. That is an idempotent success.
    if (rows.some((row) => String(row?.user_id || "") !== userId || String(row?.thread_key || "") !== threadKey)) {
      return null;
    }
    return { pinned: false, pinnedAt: null };
  }

  const now = new Date().toISOString();
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${SMS_THREAD_PREFERENCES_TABLE}`
      + "?on_conflict=user_id,thread_key&select=user_id,thread_key,pinned_at",
    {
      method: "POST",
      headers: serviceHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }),
      body: JSON.stringify([{
        user_id: userId,
        thread_key: threadKey,
        pinned_at: now,
        updated_at: now,
      }]),
    },
  );
  if (!response.ok) return null;
  const rows = await response.json().catch(() => null);
  const saved = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (
    !saved
    || String(saved.user_id || "") !== userId
    || String(saved.thread_key || "") !== threadKey
  ) return null;
  return { pinned: true, pinnedAt: String(saved.pinned_at || now) };
}

function cleanThreadMetadata(value, access) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const entries = Object.entries(source)
    .filter(([key, meta]) => {
      const line = String(key || "").split("|", 1)[0];
      return ((line === "automation" && access.automation) || (line === "main" && access.main))
        && meta && typeof meta === "object" && VALID_KINDS.has(String(meta.kind || "").toLowerCase());
    })
    .slice(-MAX_THREAD_META)
    .map(([key, meta]) => [key, {
      kind: String(meta.kind).toLowerCase(),
      leadId: String(meta.leadId || "").slice(0, 160),
      updatedAt: String(meta.updatedAt || "").slice(0, 40),
    }]);
  return Object.fromEntries(entries);
}

async function readThreadMetadata(access) {
  const state = await readAppStateVersioned(SMS_THREAD_META_KEY);
  return cleanThreadMetadata(state.exists ? state.value : {}, access);
}

function serializeSmsRow(row) {
  const descriptors = Array.isArray(row?.sms_media) ? row.sms_media : [];
  // List refreshes can return hundreds of messages. Do not spend one Storage signing request per
  // row; the authorized mediaFor branch below signs only when a staff member opens the thread.
  return {
    ...row,
    sms_media_count: descriptors.length,
    sms_media: [],
    sms_contact_avatar_url: "",
  };
}

async function enrichSmsContacts(rows) {
  const phones = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => toSmsE164(row?.sms_peer_phone || row?.from_phone))
    .filter((phone) => /^\+[1-9]\d{7,14}$/.test(phone)))];
  if (!phones.length) return rows;
  try {
    const filter = phones.map(encodeURIComponent).join(",");
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/sps_sms_contacts?select=phone,quo_contact_id,contact_name,avatar_path&phone=in.(${filter})`,
      { headers: serviceHeaders() },
    );
    if (!response.ok) return rows;
    const contacts = await response.json().catch(() => null);
    if (!Array.isArray(contacts)) return rows;
    const byPhone = new Map(contacts.map((contact) => [toSmsE164(contact?.phone), contact]));
    return rows.map((row) => {
      const phone = toSmsE164(row?.sms_peer_phone || row?.from_phone);
      const contact = byPhone.get(phone);
      if (!contact) return row;
      return {
        ...row,
        quo_contact_id: row.quo_contact_id || contact.quo_contact_id || null,
        // An SPS client match stored on the message stays first. Quo fills unknown contacts only.
        sms_contact_name: row.sms_contact_name || contact.contact_name || null,
        sms_contact_avatar_path: row.sms_contact_avatar_path || contact.avatar_path || null,
      };
    });
  } catch {
    return rows;
  }
}

async function serializeSmsMedia(row) {
  const descriptors = Array.isArray(row?.sms_media) ? row.sms_media : [];
  const signedMedia = await signPrivateSmsMedia(descriptors, {
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    expiresIn: 300,
  });
  const avatarPath = String(row?.sms_contact_avatar_path || "").trim();
  const signedAvatar = avatarPath
    ? await signPrivateSmsMedia([{ bucket: SMS_MEDIA_BUCKET, path: avatarPath, mimeType: "image/jpeg" }], {
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      expiresIn: 300,
    })
    : [];
  return {
    id: row.id,
    sms_media_count: descriptors.length,
    sms_media: signedMedia,
    sms_contact_avatar_url: signedAvatar[0]?.url || "",
  };
}

async function serializeSmsIdentities(rows) {
  const enriched = await enrichSmsContacts(rows);
  const paths = [...new Set(enriched
    .map((row) => String(row?.sms_contact_avatar_path || "").trim())
    .filter(Boolean))];
  const signed = await signPrivateSmsMedia(paths.map((path) => ({
    bucket: SMS_MEDIA_BUCKET,
    path,
    identityPath: path,
    mimeType: "image/jpeg",
  })), {
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    expiresIn: 300,
  });
  const avatarByPath = new Map(signed.map((item) => [String(item?.identityPath || item?.path || ""), String(item?.url || "")]));
  return Object.fromEntries(enriched.map((row) => [String(row.id), {
    name: String(row?.sms_contact_name || "").trim().slice(0, 180),
    contactId: String(row?.quo_contact_id || "").trim().slice(0, 120),
    avatarUrl: avatarByPath.get(String(row?.sms_contact_avatar_path || "").trim()) || "",
  }]));
}

function cleanIds(input) {
  const source = Array.isArray(input) ? input : (input == null ? [] : [input]);
  const ids = [];
  const seen = new Set();
  for (const value of source.slice(0, MAX_IDS + 1)) {
    const id = String(value == null ? "" : value).trim();
    if (!id || id.length > MAX_ID_LENGTH || !VALID_ID.test(id)) return null;
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  if (!ids.length || ids.length > MAX_IDS) return null;
  return ids;
}

function idFilter(ids) {
  return `id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})`;
}

// PostgREST JSON-path predicates keep unauthorized rows out of the database response as well as
// out of the browser response. Re-applying this predicate to PATCH/DELETE closes IDOR attempts.
function lineScopeFilter(access) {
  const clauses = [];
  if (access.main) clauses.push("ai->>quoLine.eq.main");
  if (access.automation) clauses.push("ai->>quoLine.eq.automation", "ai->>quoLine.is.null");
  const allowed = `(${clauses.join(",")})`;
  return `channel=eq.sms&or=${encodeURIComponent(allowed)}`;
}

function canAccessRow(row, access) {
  const line = rowLine(row);
  return (line === "automation" && access.automation) || (line === "main" && access.main);
}

async function readRequestedRows(ids) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/sps_inbox?select=id,channel,ai,sms_line,from_phone,sms_peer_phone,quo_conversation_id,body_text&${idFilter(ids)}`,
    { headers: serviceHeaders() },
  );
  if (!response.ok) throw new Error(`inbox lookup failed (${response.status})`);
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw new Error("inbox lookup returned invalid data");
  return rows;
}

async function requireAuthorizedRows(ids, access) {
  const rows = await readRequestedRows(ids);
  const byId = new Map(rows.map((row) => [String(row && row.id), row]));
  const authorized = ids.length === rows.length && ids.every((id) => {
    const row = byId.get(id);
    return !!row && canAccessRow(row, access);
  });
  return authorized ? rows : null;
}

async function mutateRows(method, ids, fields, access) {
  const response = await fetch(
    // PostgREST versions before 14.4 can mis-resolve columns used inside `or` on mutations unless
    // those columns are also selected. Include channel/ai as a compatibility guard; only ids are
    // copied into the API response below.
    `${SUPABASE_URL}/rest/v1/sps_inbox?${idFilter(ids)}&${lineScopeFilter(access)}&select=id,channel,ai`,
    {
      method,
      headers: serviceHeaders({ Prefer: "return=representation" }),
      ...(fields ? { body: JSON.stringify(fields) } : {}),
    },
  );
  if (!response.ok) return { ok: false, ids: [] };
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) return { ok: false, ids: [] };
  const returned = [...new Set(rows.map((row) => String((row && row.id) || "")).filter(Boolean))];
  const returnedSet = new Set(returned);
  return { ok: ids.every((id) => returnedSet.has(id)), ids: returned };
}

function accessFor(staff) {
  const owner = staff.teamRole === "owner";
  return {
    automation: owner || memberHasCapability(staff.teamMember, "commsTextInbox"),
    main: owner || memberHasCapability(staff.teamMember, "commsMainLine"),
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!SERVICE_KEY) {
    return res.status(501).json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });
  }

  const staff = await requireStaff(req, res, "using the business text inbox");
  if (!staff) return;
  const access = accessFor(staff);
  if (!access.automation && !access.main) {
    return res.status(403).json({ error: "Your team permissions do not allow viewing a business text inbox." });
  }

  try {
    if (req.method === "GET") {
      const query = req.query || {};
      if (query.threadMeta === "1") {
        return res.status(200).json({ ok: true, threads: await readThreadMetadata(access), access });
      }
      if (query.threadPrefs === "1") {
        const userId = String(staff.id || "");
        const preferences = await readThreadPreferences(userId, access);
        if (!preferences) {
          return res.status(200).json({
            ok: true,
            preferences: {},
            setupRequired: true,
            access,
          });
        }
        return res.status(200).json({ ok: true, preferences, access });
      }
      if (query.mediaFor != null) {
        const ids = cleanIds(query.mediaFor);
        if (!ids || ids.length !== 1) return res.status(400).json({ error: "Provide one valid text-message id." });
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/sps_inbox?select=id,channel,ai,sms_line,from_phone,sms_peer_phone,sms_media,sms_contact_avatar_path&${idFilter(ids)}`,
          { headers: serviceHeaders() },
        );
        if (!response.ok) return res.status(409).json({ error: "Text media is not ready. Run SMS-CONVERSATIONS-RUN.sql." });
        const rows = await response.json().catch(() => null);
        if (!Array.isArray(rows) || rows.length !== 1 || !canAccessRow(rows[0], access)) {
          return res.status(403).json({ error: "That text message is unavailable with your current permissions." });
        }
        const [enriched] = await enrichSmsContacts(rows);
        return res.status(200).json({ ok: true, media: await serializeSmsMedia(enriched), access });
      }
      if (query.identityFor != null) {
        const ids = cleanIds(query.identityFor);
        if (!ids || ids.length > MAX_IDENTITY_IDS) {
          return res.status(400).json({ error: `Provide one to ${MAX_IDENTITY_IDS} valid text-message ids.` });
        }
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/sps_inbox`
            + "?select=id,channel,ai,sms_line,from_phone,sms_peer_phone,quo_conversation_id,body_text,"
            + `quo_contact_id,sms_contact_name,sms_contact_avatar_path&${idFilter(ids)}`,
          { headers: serviceHeaders() },
        );
        if (!response.ok) {
          return res.status(409).json({ error: "Text identities are not ready. Run SMS-CONVERSATIONS-RUN.sql." });
        }
        const rows = await response.json().catch(() => null);
        if (!Array.isArray(rows) || rows.length !== ids.length) {
          return res.status(403).json({ error: "One or more text conversations are unavailable with your current permissions." });
        }
        const byId = new Map(rows.map((row) => [String(row?.id || ""), row]));
        const ordered = ids.map((id) => byId.get(id));
        if (ordered.some((row) => !row || !canAccessRow(row, access))) {
          return res.status(403).json({ error: "One or more text conversations are unavailable with your current permissions." });
        }
        return res.status(200).json({
          ok: true,
          identities: await serializeSmsIdentities(ordered),
          access,
        });
      }
      if (query.conversationFor != null) {
        const ids = cleanIds(query.conversationFor);
        if (!ids || ids.length !== 1) return res.status(400).json({ error: "Provide one valid text-message id." });
        const anchorResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/sps_inbox?select=*&${idFilter(ids)}&limit=1`,
          { headers: serviceHeaders() },
        );
        if (!anchorResponse.ok) {
          return res.status(409).json({ error: "Text history is not ready. Run SMS-CONVERSATIONS-RUN.sql." });
        }
        const anchorRows = await anchorResponse.json().catch(() => null);
        const anchor = Array.isArray(anchorRows) ? anchorRows[0] : null;
        if (!anchor || !canAccessRow(anchor, access)) {
          return res.status(403).json({ error: "That text conversation is unavailable with your current permissions." });
        }

        const line = rowLine(anchor);
        const peer = rowConversationPeer(anchor);
        const storedPeer = toSmsE164(anchor.sms_peer_phone || anchor.from_phone);
        const providerId = String(anchor.quo_conversation_id || "").trim();
        if (!line || (!peer && !providerId)) {
          return res.status(409).json({ error: "That text conversation has no usable participant information." });
        }

        const limit = Math.min(300, Math.max(20, Number.parseInt(query.limit, 10) || 200));
        const params = [
          "select=*",
          "channel=eq.sms",
          `sms_line=eq.${encodeURIComponent(line)}`,
          "order=created_at.desc",
          `limit=${limit + 1}`,
        ];
        // Test Mode history can store the carrier/test number while its protected body prefix
        // identifies the intended customer. Fetch that narrow stored peer, then filter each row by
        // the intended peer below. Normal live rows use their customer E.164 directly.
        if (storedPeer) params.push(`sms_peer_phone=eq.${encodeURIComponent(storedPeer)}`);
        else params.push(`quo_conversation_id=eq.${encodeURIComponent(providerId)}`);
        const historyResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/sps_inbox?${params.join("&")}`,
          { headers: serviceHeaders() },
        );
        if (!historyResponse.ok) {
          return res.status(409).json({ error: "Text history is not ready. Run SMS-CONVERSATIONS-RUN.sql." });
        }
        const historyRows = await historyResponse.json().catch(() => null);
        if (!Array.isArray(historyRows)) return res.status(502).json({ error: "The text conversation returned invalid data." });
        const authorizedRows = historyRows
          .filter((row) => canAccessRow(row, access) && sameConversation(row, { line, peer, providerId }));
        const hasMore = authorizedRows.length > limit;
        const safeRows = (await enrichSmsContacts(authorizedRows.slice(0, limit))).map(serializeSmsRow);
        return res.status(200).json({ ok: true, rows: safeRows, hasMore, access });
      }
      if (query.summary === "actionable") {
        const summaryLimit = 200;
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/sps_inbox?select=${encodeURIComponent(ACTIONABLE_SMS_FIELDS)}`
            + `&${lineScopeFilter(access)}&order=created_at.desc&limit=${summaryLimit}`,
          { headers: serviceHeaders() },
        );
        if (!response.ok) return res.status(502).json({ error: "The text inbox could not be loaded." });
        const rows = await response.json().catch(() => null);
        if (!Array.isArray(rows)) return res.status(502).json({ error: "The text inbox returned invalid data." });
        // The service role bypasses RLS. Re-validate every row even though PostgREST is already
        // line-scoped, then group messages before counting so one customer thread is one item.
        const authorizedRows = rows.filter((row) => canAccessRow(row, access));
        const counts = summarizeActionableCommsRows(mergeInboxConversationRows(authorizedRows));
        return res.status(200).json({
          ok: true,
          actionable: counts.total,
          count: counts.total,
          capped: rows.length >= summaryLimit,
          counts,
          access,
        });
      }
      if (query.summary === "unread") {
        const response = await fetch(
          // `not.is.true` includes both false and legacy null values without adding a second
          // top-level `or` query parameter (duplicate logical parameters are ambiguous). Include
          // the small line fields so malformed metadata can be rejected again before it affects
          // even the unread count; body/html columns remain excluded.
          `${SUPABASE_URL}/rest/v1/sps_inbox?select=id,channel,ai&${lineScopeFilter(access)}&read=not.is.true&limit=100`,
          { headers: serviceHeaders() },
        );
        if (!response.ok) return res.status(502).json({ error: "The text inbox could not be loaded." });
        const rows = await response.json().catch(() => null);
        if (!Array.isArray(rows)) return res.status(502).json({ error: "The text inbox returned invalid data." });
        const unread = rows.filter((row) => canAccessRow(row, access)).length;
        return res.status(200).json({ ok: true, unread, capped: unread >= 100, access });
      }

      const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit, 10) || 100));
      const params = ["select=*", lineScopeFilter(access), "order=created_at.desc", `limit=${limit}`];
      const kind = String(query.kind || "").trim().toLowerCase();
      if (kind && VALID_KINDS.has(kind)) params.push(`kind=eq.${encodeURIComponent(kind)}`);
      if (query.unimported === "1") params.push("lead_id=eq.");
      const response = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?${params.join("&")}`, { headers: serviceHeaders() });
      if (!response.ok) return res.status(502).json({ error: "The text inbox could not be loaded." });
      const rows = await response.json().catch(() => null);
      if (!Array.isArray(rows)) return res.status(502).json({ error: "The text inbox returned invalid data." });
      // The database predicate is the primary filter. Validate again before serialization so a
      // PostgREST/schema regression still cannot place a main or unknown-line row in a staff reply.
      const authorizedRows = rows.filter((row) => canAccessRow(row, access)).slice(0, limit);
      const safeRows = (await enrichSmsContacts(authorizedRows)).map(serializeSmsRow);
      return res.status(200).json({ ok: true, rows: safeRows, access });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });
    const body = req.body || {};
    const action = String(body.action || "");
    const ids = cleanIds(
      action === "setPinned"
        ? body.anchorId
        : (action === "markImported" ? body.id : (body.ids != null ? body.ids : body.id)),
    );
    if (!ids) return res.status(400).json({ error: "Provide one to 200 valid text-message ids." });

    const allowedActions = new Set([
      "markRead",
      "markReplied",
      "setKind",
      "setThreadKind",
      "setPinned",
      "markImported",
      "delete",
    ]);
    if (!allowedActions.has(action)) return res.status(400).json({ error: "Unknown text-inbox action." });

    // A line visibility/reply grant must never imply authority to destroy shared history or alter
    // its business classification. Keep those actions owner-only until the product has a separate,
    // explicit inbox-management permission.
    const ownerOnlyActions = new Set(["delete", "setKind", "setThreadKind", "markImported"]);
    if (ownerOnlyActions.has(action) && staff.teamRole !== "owner") {
      return res.status(403).json({ ok: false, error: "Owner access is required to manage text-message records." });
    }

    const authorizedRows = await requireAuthorizedRows(ids, access);
    if (!authorizedRows) {
      return res.status(403).json({ ok: false, error: "One or more text messages are unavailable with your current permissions." });
    }
    if (action === "markReplied" && staff.teamRole !== "owner" && authorizedRows.some((row) => rowLine(row) === "main")) {
      return res.status(403).json({ ok: false, error: "Only the owner can reply from the owner's work line." });
    }

    if (action === "setPinned") {
      if (authorizedRows.length !== 1) return res.status(400).json({ error: "Choose one text conversation." });
      if (typeof body.pinned !== "boolean") return res.status(400).json({ error: "Choose whether to pin or unpin this conversation." });
      const threadKey = rowThreadKey(authorizedRows[0]);
      if (!threadKey || !canAccessThreadKey(threadKey, access)) {
        return res.status(409).json({ error: "That text conversation has no usable participant information." });
      }
      const result = await setThreadPinned(String(staff.id || ""), threadKey, body.pinned);
      if (!result) {
        return res.status(409).json({
          ok: false,
          error: "The pin could not be saved. Run SMS-THREAD-PREFERENCES-RUN.sql, then try again.",
        });
      }
      return res.status(200).json({
        ok: true,
        threadKey,
        pinned: result.pinned,
        pinnedAt: result.pinnedAt,
        access,
      });
    }

    if (action === "setThreadKind") {
      if (authorizedRows.length !== 1) return res.status(400).json({ error: "Choose one text conversation." });
      const kind = String(body.kind || "").trim().toLowerCase();
      if (!VALID_KINDS.has(kind)) return res.status(400).json({ error: "Choose a valid conversation category." });
      const threadKey = rowThreadKey(authorizedRows[0]);
      if (!threadKey) return res.status(409).json({ error: "That text conversation has no usable participant information." });
      const leadId = kind === "lead" ? String(body.leadId || "").trim().slice(0, 160) : "";
      const updatedAt = new Date().toISOString();
      const mutation = await mutateAppState(SMS_THREAD_META_KEY, (current) => {
        const source = current && typeof current === "object" && !Array.isArray(current) ? current : {};
        const next = { ...source, [threadKey]: { kind, leadId, updatedAt } };
        const entries = Object.entries(next);
        if (entries.length <= MAX_THREAD_META) return next;
        entries.sort((a, b) => String(a[1]?.updatedAt || "").localeCompare(String(b[1]?.updatedAt || "")));
        return Object.fromEntries(entries.slice(entries.length - MAX_THREAD_META));
      });
      return res.status(200).json({ ok: true, threadKey, meta: mutation.value?.[threadKey] || { kind, leadId, updatedAt }, access });
    }

    let fields = null;
    if (action === "markRead") fields = { read: body.read !== false };
    else if (action === "markReplied") fields = { replied: true };
    else if (action === "setKind") {
      const kind = String(body.kind || "").trim().toLowerCase();
      if (!VALID_KINDS.has(kind)) return res.status(400).json({ error: "Choose a valid message category." });
      fields = { kind };
    } else if (action === "markImported") {
      const leadId = String(body.leadId == null ? "" : body.leadId).trim();
      if (!leadId || leadId.length > 160) return res.status(400).json({ error: "Need id + leadId." });
      fields = { lead_id: leadId };
    }

    const mutation = await mutateRows(action === "delete" ? "DELETE" : "PATCH", ids, fields, access);
    if (!mutation.ok) {
      return res.status(409).json({
        ok: false,
        error: "The text inbox changed before that action finished. Refresh and try again.",
        updatedIds: mutation.ids,
      });
    }
    if (action === "delete") {
      return res.status(200).json({ ok: true, deleted: mutation.ids.length, deletedIds: mutation.ids, access });
    }
    return res.status(200).json({ ok: true, updated: mutation.ids.length, updatedIds: mutation.ids, access });
  } catch (error) {
    console.error("[sms-inbox] request failed:", error && error.message ? error.message : error);
    return res.status(502).json({ error: "The text inbox could not complete that request." });
  }
}
