// api/ingest-lead.js
// The bridge that turns inbound website leads into app-visible leads. Two ways in:
//   1) A Supabase DATABASE WEBHOOK on public.leads INSERT (instant) — Supabase posts { type:"INSERT", record:{...} }.
//   2) A manual / backfill call (GET or POST with no `record`) — mirrors ALL public.leads rows where handled=false.
// Either way it normalizes the row into the app's lead shape, upserts into the app_state key `sps_leads`
// (idempotent by srcId = the public.leads uuid), and flips public.leads.handled=true. SERVICE-ROLE only —
// this is the ONLY thing that can SELECT the owner-read-only public.leads table.
//
// Auth: requires `Authorization: Bearer <CRON_SECRET>` (the same secret the cron already uses, so there's
// nothing new to set). Add that header in the Supabase webhook config. Without it the call is rejected.
//
// Env (Vercel): SUPABASE_SERVICE_ROLE_KEY (required), CRON_SECRET (required to authorize), optional SUPABASE_URL.
// Phase 1 = mirror only. Phase 2 will add the instant auto-reply + owner alert here.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CRON_SECRET  = process.env.CRON_SECRET || "";

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });

async function readKey(key, fallback) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?select=value&key=eq.${encodeURIComponent(key)}`, { headers: sbHeaders() });
  if (!r.ok) return fallback;
  const rows = await r.json().catch(() => []);
  const row = rows && rows[0];
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
async function writeKey(key, value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=key`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }),
  });
  return r.ok;
}
async function fetchUnhandledLeads() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/leads?select=*&handled=eq.false&order=created_at.asc&limit=200`, { headers: sbHeaders() });
  if (!r.ok) return [];
  return (await r.json().catch(() => [])) || [];
}
async function markHandled(id) {
  if (id == null) return;
  await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { ...sbHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify({ handled: true }),
  }).catch(() => {});
}

// Best-effort map of a website service value → a division (null when unknown; the owner sets it on convert).
function mapDivision(service) {
  const s = String(service || "").toLowerCase();
  if (/pool|spa|hot ?tub/.test(s)) return "Pool";
  if (/leaf|gutter|snow|seasonal|property/.test(s)) return "Seasonal";
  if (/pond|koi|water/.test(s)) return "Pond";
  return null;
}

// Turn a raw public.leads row into the app's lead shape. Trim long fields so sps_leads stays small.
function normalize(row) {
  const src = String(row.source || "");
  const channel = /sms|email|phone|walkin|import/i.test(src) ? src.toLowerCase().match(/sms|email|phone|walkin|import/i)[0] : "website";
  return {
    id: `lead_${row.id || Date.now()}`,
    srcId: row.id != null ? String(row.id) : null,   // public.leads uuid — idempotency key
    source: channel,
    sourceDetail: src.slice(0, 120),                 // page path / channel detail
    name: String(row.name || "").slice(0, 120),
    phone: String(row.phone || "").slice(0, 40),
    email: String(row.email || "").slice(0, 160),
    street: "", city: "", state: "", zip: "",
    service: String(row.service || "").slice(0, 80),
    mappedDivision: mapDivision(row.service),
    message: String(row.message || "").slice(0, 800),
    consent: !!row.consent,
    status: "new",          // new | contacted | qualified | won | lost
    assignedTo: null,       // delegation hook — owner-only today
    timeline: [{ at: row.created_at || new Date().toISOString(), by: "system", kind: "captured", text: "Lead captured" }],
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    convertedClientId: null,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!SERVICE_KEY) return res.status(501).json({ error: "server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });
  const auth = req.headers.authorization || "";
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "unauthorized" });

  // One webhook record, or all unhandled rows on a manual/backfill call.
  const body = req.body || {};
  const rows = (body && body.record && (body.type === "INSERT" || body.type === "UPDATE"))
    ? [body.record]
    : await fetchUnhandledLeads();
  if (!rows.length) return res.status(200).json({ ok: true, ingested: 0 });

  const leads = (await readKey("sps_leads", [])) || [];
  const seen = new Set(leads.map(l => l && l.srcId).filter(Boolean));
  let added = 0;
  for (const row of rows) {
    const lead = normalize(row);
    if (lead.srcId && seen.has(lead.srcId)) { await markHandled(row.id); continue; } // already mirrored
    leads.unshift(lead);
    if (lead.srcId) seen.add(lead.srcId);
    added++;
    await markHandled(row.id);
  }
  if (added) await writeKey("sps_leads", leads);
  return res.status(200).json({ ok: true, ingested: added });
}
