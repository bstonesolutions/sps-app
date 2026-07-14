// Small retention helper for the token-scoped live-tracking records stored in app_state.
// Tracking links already stop working at expiresAt (or one hour after a legacy `at` value), but
// the rows previously remained forever and were copied into every full app-state read/backup.

const DEFAULT_SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const DEFAULT_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TRACKING_KEY_RE = /^sps_track_[A-Za-z0-9_-]{8,128}$/;
const LEGACY_TRACKING_TTL_MS = 60 * 60 * 1000;

function parseStoredValue(value) {
  let parsed = value;
  for (let pass = 0; pass < 2 && typeof parsed === "string"; pass += 1) {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

export function trackingRecordExpiry(value) {
  const record = parseStoredValue(value);
  if (!record) return 0;
  const explicit = Date.parse(record.expiresAt || "");
  if (Number.isFinite(explicit)) return explicit;
  const legacyBase = Date.parse(record.at || "");
  return Number.isFinite(legacyBase) ? legacyBase + LEGACY_TRACKING_TTL_MS : 0;
}

export function expiredTrackingKeys(rows, now = Date.now()) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String((row && row.key) || "");
    if (!TRACKING_KEY_RE.test(key) || seen.has(key)) continue;
    const expiry = trackingRecordExpiry(row.value);
    if (expiry > 0 && now >= expiry) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export function expiredTrackingRecords(rows, now = Date.now()) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String((row && row.key) || "");
    const version = Number(row && row.version);
    if (!TRACKING_KEY_RE.test(key) || seen.has(key) || !Number.isSafeInteger(version) || version < 1) continue;
    const expiry = trackingRecordExpiry(row.value);
    if (expiry > 0 && now >= expiry) {
      seen.add(key);
      out.push({ key, version });
    }
  }
  return out;
}

export async function pruneExpiredTrackingRecords({
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  supabaseUrl = DEFAULT_SUPABASE_URL,
  serviceKey = DEFAULT_SERVICE_KEY,
  scanLimit = 5000,
  deleteLimit = 250,
} = {}) {
  if (!serviceKey || typeof fetchImpl !== "function") {
    return { ok: false, skipped: "maintenance unavailable", scanned: 0, eligible: 0, deleted: 0, renewed: 0 };
  }

  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const maxScan = Math.max(1, Math.min(20000, Number(scanLimit) || 5000));
  const pageSize = Math.min(500, maxScan);
  const rows = [];
  // Stable, oldest-first paging prevents an arbitrary first page from permanently hiding older
  // expired rows. In normal use this is one small request; extra pages are read only if needed.
  for (let offset = 0; offset < maxScan; offset += pageSize) {
    const take = Math.min(pageSize, maxScan - offset);
    const scanUrl = new URL("/rest/v1/app_state", supabaseUrl);
    scanUrl.searchParams.set("select", "key,value,version,updated_at");
    scanUrl.searchParams.set("key", "like.sps_track_*");
    scanUrl.searchParams.set("order", "updated_at.asc,key.asc");
    scanUrl.searchParams.set("limit", String(take));
    scanUrl.searchParams.set("offset", String(offset));
    const scanResponse = await fetchImpl(scanUrl, { headers });
    if (!scanResponse.ok) throw new Error(`tracking scan failed (${scanResponse.status})`);
    const page = await scanResponse.json().catch(() => []);
    const pageRows = Array.isArray(page) ? page : [];
    rows.push(...pageRows);
    if (pageRows.length < take) break;
  }

  const expired = expiredTrackingRecords(rows, now);
  const candidates = expired.slice(0, Math.max(1, Math.min(500, Number(deleteLimit) || 250)));
  if (!candidates.length) {
    return { ok: true, scanned: rows.length, eligible: expired.length, deleted: 0, renewed: 0 };
  }

  let deleted = 0;
  // Delete in compact batches, with the version from the scan included in every predicate. If a
  // tech renews a link after we inspect it, that write increments the version and this DELETE no
  // longer matches it. The renewed live record is therefore preserved without 250 RPC round trips.
  for (let index = 0; index < candidates.length; index += 50) {
    const chunk = candidates.slice(index, index + 50);
    const deleteUrl = new URL("/rest/v1/app_state", supabaseUrl);
    deleteUrl.searchParams.set("or", `(${chunk.map(({ key, version }) => `and(key.eq.${key},version.eq.${version})`).join(",")})`);
    deleteUrl.searchParams.set("select", "key,version");
    const deleteResponse = await fetchImpl(deleteUrl, {
      method: "DELETE",
      headers: { ...headers, Prefer: "return=representation" },
    });
    if (!deleteResponse.ok) throw new Error(`tracking cleanup failed (${deleteResponse.status})`);
    const deletedRows = await deleteResponse.json().catch(() => []);
    deleted += Array.isArray(deletedRows) ? deletedRows.length : 0;
  }
  return { ok: true, scanned: rows.length, eligible: expired.length, deleted, renewed: candidates.length - deleted };
}
