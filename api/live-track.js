// Public, token-scoped live tracking endpoint.
//
// A tracking URL is a bearer capability: possession of the unguessable token is the only access
// required. The browser never receives Supabase table access. This handler resolves one exact
// tracking record with the service role and returns the assigned technician's location only while
// that record is active and unexpired.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
const ACTIVE_STATUSES = new Set(["enroute", "arrived"]);

export function isFreshLiveLocation(location, now = Date.now()) {
  const updatedAt = Date.parse((location && location.updated_at) || "");
  const ageMs = Number(now) - updatedAt;
  return !!(
    location && location.is_active && location.lat != null && location.lng != null &&
    Number.isFinite(updatedAt) && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 90 * 1000
  );
}

function serviceHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
}

function parseStoredValue(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function safeRecord(record) {
  return {
    client: String(record.client || "there").slice(0, 80),
    address: String(record.address || "").slice(0, 300),
    status: String(record.status || "scheduled").slice(0, 24),
    at: typeof record.at === "string" ? record.at.slice(0, 64) : null,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt.slice(0, 64) : null,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!SERVICE_KEY) return res.status(503).json({ error: "Tracking is unavailable." });

  const token = String((req.query && req.query.token) || "").trim();
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: "Tracking link not found." });

  try {
    const key = encodeURIComponent(`sps_track_${token}`);
    const recordResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?select=value&key=eq.${key}&limit=1`,
      { headers: serviceHeaders() }
    );
    if (!recordResponse.ok) return res.status(502).json({ error: "Tracking is unavailable." });
    const rows = await recordResponse.json().catch(() => []);
    const record = parseStoredValue(rows && rows[0] && rows[0].value);
    if (!record || !record.assigneeId) return res.status(404).json({ error: "Tracking link not found." });

    // New records carry an explicit expiry. Legacy records are capped at 60 minutes from their last
    // tracking update so old links cannot remain a permanent window into a technician's location.
    const explicitExpiry = Date.parse(record.expiresAt || "");
    const legacyBase = Date.parse(record.at || "");
    const expiry = Number.isFinite(explicitExpiry)
      ? explicitExpiry
      : (Number.isFinite(legacyBase) ? legacyBase + 60 * 60 * 1000 : 0);
    if (!expiry || Date.now() >= expiry) {
      return res.status(410).json({ error: "This tracking session has ended.", ended: true });
    }

    const publicRecord = safeRecord(record);
    if (!ACTIVE_STATUSES.has(String(record.status || "").toLowerCase())) {
      return res.status(200).json({ record: publicRecord, location: null });
    }

    const staffId = encodeURIComponent(String(record.assigneeId));
    const locationResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/staff_locations?select=lat,lng,updated_at,is_active&staff_id=eq.${staffId}&limit=1`,
      { headers: serviceHeaders() }
    );
    if (!locationResponse.ok) return res.status(200).json({ record: publicRecord, location: null });
    const locations = await locationResponse.json().catch(() => []);
    const location = locations && locations[0];
    // Foreground tracking writes at most every 30 seconds. A 90-second lease tolerates two missed
    // updates but fails closed quickly if iOS suspends the app, the network disappears, or auth is
    // revoked before the client can mark its row inactive.
    const fresh = isFreshLiveLocation(location);
    return res.status(200).json({
      record: publicRecord,
      location: fresh ? {
        lat: Number(location.lat),
        lng: Number(location.lng),
        updated_at: location.updated_at,
        is_active: true,
      } : null,
    });
  } catch (_) {
    return res.status(500).json({ error: "Tracking is unavailable." });
  }
}
