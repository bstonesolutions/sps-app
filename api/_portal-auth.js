// Shared security boundary for client-portal API routes.
//
// Portal callers are regular Supabase users, but their identity is never taken from
// request data. We verify the Bearer token, resolve a bound auth UID first (with a unique
// verified-email fallback for legacy records), and use the service role only after that
// ownership check has succeeded.
import { verifyUser } from "./_auth.js";

// This helper deliberately reads app_state through the service role without requiring the
// version column. It is the pre-migration bridge: it works against today's schema, continues to
// work after RLS closes direct portal access, and does not activate CAS-only writers early.
export const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://ysqarusrewceezckawlo.supabase.co"
).replace(/\/+$/, "");
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const lc = (value) => String(value == null ? "" : value).trim().toLowerCase();

export function setPortalCors(res, methods = "GET, POST, PATCH, OPTIONS") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Authorization");
}

export function decodeStoredValue(value) {
  let out = value;
  for (let i = 0; i < 2 && typeof out === "string"; i += 1) {
    try { out = JSON.parse(out); } catch { break; }
  }
  return out;
}

const safeDecode = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

// Server-local parser for the durable Storage references the portal is allowed to sign. Keeping
// this narrow helper here avoids pulling browser backup/migration code into the API bridge.
function parseStorageLocator(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("sps-storage://")) {
    try {
      const url = new URL(value);
      const bucket = safeDecode(url.hostname);
      const path = url.pathname.replace(/^\/+/, "").split("/").map(safeDecode).join("/");
      return bucket && path ? { bucket, path } : null;
    } catch { return null; }
  }
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/storage\/v1\/(?:render\/image\/)?object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
    if (!match) return null;
    const bucket = safeDecode(match[1]);
    const path = match[2].split("/").map(safeDecode).join("/");
    return bucket && path ? { bucket, path } : null;
  } catch { return null; }
}

const serviceHeaders = (extra = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  ...extra,
});

export async function readAppState(key) {
  if (!SERVICE_KEY) throw new Error("server_not_configured");
  const safeKey = String(key || "");
  if (!/^[A-Za-z0-9_]+$/.test(safeKey)) throw new Error("app_state_key_invalid");
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/app_state?select=value&key=eq.${encodeURIComponent(safeKey)}&limit=1`,
    { headers: serviceHeaders() }
  );
  if (!response.ok) throw new Error("app_state_read_failed");
  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? decodeStoredValue(row.value) : null;
}

export async function readAppStateKeys(keys) {
  if (!SERVICE_KEY) throw new Error("server_not_configured");
  const safeKeys = (keys || []).filter((key) => /^[A-Za-z0-9_]+$/.test(String(key)));
  if (!safeKeys.length) return {};
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/app_state?select=key,value&key=in.(${safeKeys.join(",")})`,
    { headers: serviceHeaders() }
  );
  if (!r.ok) throw new Error("app_state_read_failed");
  const rows = await r.json().catch(() => []);
  const out = {};
  for (const row of rows || []) out[row.key] = decodeStoredValue(row.value);
  return out;
}

export function clientOwnsInvoice(invoice, client, clients = []) {
  if (!invoice || !client) return false;
  if (invoice.clientId != null) return String(invoice.clientId) === String(client.id);
  if (!invoice.clientName || lc(invoice.clientName) !== lc(client.name)) return false;
  // Legacy QuickBooks imports can lack clientId. A name fallback is safe only when that
  // normalized name uniquely identifies one client; duplicate names fail closed.
  return Array.isArray(clients) && clients.filter((item) => lc(item && item.name) === lc(client.name)).length === 1;
}

export function resolvePortalClient(clients, user) {
  const list = Array.isArray(clients) ? clients : [];
  const finish = (client) => {
    if (!client || client.id == null) return { client, reason: null };
    const idMatches = list.filter((item) => item && item.id != null && String(item.id) === String(client.id));
    return idMatches.length === 1
      ? { client, reason: null }
      : { client: null, reason: "duplicate_client_id" };
  };
  const uid = String((user && user.id) || "").trim();
  const uidMatches = uid ? list.filter((client) =>
    String((client && (client.auth_user_id || client.authUserId)) || "").trim() === uid
  ) : [];
  if (uidMatches.length > 1) return { client: null, reason: "duplicate_binding" };
  if (uidMatches.length === 1) return finish(uidMatches[0]);

  const email = lc(user && user.email);
  const emailMatches = email ? list.filter((client) => lc(client && client.email) === email) : [];
  if (emailMatches.length > 1) return { client: null, reason: "duplicate_email" };
  if (emailMatches.length === 0) return { client: null, reason: "not_found" };
  const boundUid = String((emailMatches[0].auth_user_id || emailMatches[0].authUserId) || "").trim();
  if (boundUid && boundUid !== uid) return { client: null, reason: "bound_elsewhere" };
  return finish(emailMatches[0]);
}

export async function requirePortalClient(req, res) {
  if (!SERVICE_KEY) {
    res.status(500).json({ error: "Server is not configured for the client portal." });
    return null;
  }
  const user = await verifyUser(req);
  if (!user || !user.email) {
    res.status(401).json({ error: "Please sign in again." });
    return null;
  }
  let clients;
  try {
    clients = await readAppState("sps_clients");
  } catch (_) {
    res.status(502).json({ error: "Could not verify the client account." });
    return null;
  }
  if (!Array.isArray(clients)) clients = [];
  const resolved = resolvePortalClient(clients, user);
  if (["duplicate_binding", "duplicate_email", "duplicate_client_id"].includes(resolved.reason)) {
    res.status(409).json({ error: "This sign-in matches more than one client record. Ask the office to link the correct portal account." });
    return null;
  }
  const client = resolved.client;
  if (!client || !["string", "number"].includes(typeof client.id) || String(client.id).trim() === "") {
    res.status(403).json({ error: "This account is not linked to a client portal." });
    return null;
  }
  return { user, client, clients };
}

export const portalServiceHeaders = serviceHeaders;

// Portal clients cannot receive blanket Storage read permission: a policy that allowed any
// authenticated client to select from `client-media` would expose every customer's files. Sign
// only references in actual media fields of this authenticated client's allowlisted payload.
// Text such as clientFeedback is client-writable and must never become an object-signing oracle.
// The browser refreshes portal-data before these one-hour links expire.
function portalMediaPath(path) {
  if (path.length === 2 && path[0] === "branding") {
    return path[1] === "logoImage" || path[1] === "portalHeroImage";
  }
  if (path[0] !== "client") return false;

  const pointer = (value) => value === "src" || value === "poster";
  const directCollections = new Set(["sitePhotos", "siteVideos", "documents"]);
  if (directCollections.has(path[1])) {
    return (path.length === 3 && typeof path[2] === "number") ||
      (path.length === 4 && typeof path[2] === "number" && pointer(path[3]));
  }

  const nestedCollections = new Set(["history", "equipment", "fishHistory"]);
  if (nestedCollections.has(path[1]) && path[3] === "photos") {
    return (path.length === 5 && typeof path[2] === "number" && typeof path[4] === "number") ||
      (path.length === 6 && typeof path[2] === "number" && typeof path[4] === "number" && pointer(path[5]));
  }
  return false;
}

export async function signPortalMedia(value, { expiresIn = 60 * 60 } = {}) {
  const paths = new Set();
  const collect = (item, path = []) => {
    if (typeof item === "string") {
      if (!portalMediaPath(path)) return;
      const locator = parseStorageLocator(item);
      if (locator && locator.bucket === "client-media") paths.add(locator.path);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => collect(child, [...path, index]));
      return;
    }
    if (item && typeof item === "object") {
      Object.entries(item).forEach(([key, child]) => collect(child, [...path, key]));
    }
  };
  collect(value);
  if (!paths.size) return value;
  const requestedPaths = [...paths];

  const ttl = Math.max(60, Math.min(60 * 60, Number(expiresIn) || 60 * 60));
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/client-media`,
    {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: ttl, paths: requestedPaths }),
    }
  );
  if (!response.ok) {
    const error = new Error("portal_media_sign_failed");
    error.unavailableCount = requestedPaths.length;
    throw error;
  }
  const rows = await response.json().catch(() => []);
  const signedByPath = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.error || typeof row.path !== "string") continue;
    const relative = row.signedURL || row.signedUrl;
    if (typeof relative !== "string" || !relative) continue;
    const signedUrl = /^https?:\/\//i.test(relative)
      ? relative
      : `${SUPABASE_URL}/storage/v1${relative.startsWith("/") ? "" : "/"}${relative}`;
    signedByPath.set(row.path, signedUrl);
  }

  const replace = (item, path = []) => {
    if (typeof item === "string") {
      if (!portalMediaPath(path)) return item;
      const locator = parseStorageLocator(item);
      return locator && locator.bucket === "client-media"
        ? (signedByPath.get(locator.path) || item)
        : item;
    }
    if (Array.isArray(item)) return item.map((child, index) => replace(child, [...path, index]));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, replace(child, [...path, key])]));
    }
    return item;
  };
  const signedValue = replace(value);
  const missingPaths = requestedPaths.filter((path) => !signedByPath.has(path));
  if (missingPaths.length) {
    const error = new Error("portal_media_sign_incomplete");
    error.unavailableCount = missingPaths.length;
    error.partialValue = signedValue;
    throw error;
  }
  return signedValue;
}
