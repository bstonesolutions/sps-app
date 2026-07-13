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

import { mutateAppState, NO_APP_STATE_CHANGE } from "./_app-state.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CRON_SECRET  = process.env.CRON_SECRET || "";

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });

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

  // Normalize once so CAS retries are deterministic (timestamps/ids do not change per attempt).
  const candidates = rows.map((row) => ({ row, lead: normalize(row) }));
  let added = 0;
  let persistedSourceIds = new Set();
  try {
    await mutateAppState("sps_leads", (current) => {
      const leads = Array.isArray(current) ? current : [];
      const next = leads.slice();
      const seen = new Set(leads.map((lead) => lead && lead.srcId).filter(Boolean).map(String));
      const persisted = new Set();
      let addedThisAttempt = 0;
      for (const { row, lead } of candidates) {
        const sourceId = lead.srcId ? String(lead.srcId) : "";
        if (sourceId && seen.has(sourceId)) { persisted.add(sourceId); continue; }
        next.unshift(lead);
        if (sourceId) { seen.add(sourceId); persisted.add(sourceId); }
        else if (row.id != null) persisted.add(String(row.id));
        addedThisAttempt += 1;
      }
      added = addedThisAttempt;
      persistedSourceIds = persisted;
      return addedThisAttempt ? next : NO_APP_STATE_CHANGE;
    });
  } catch (error) {
    console.error("lead app_state mutation failed:", error && error.message ? error.message : error);
    return res.status(502).json({ ok: false, error: "Could not persist leads; the source rows remain queued for retry." });
  }

  // Only acknowledge source rows after the app_state mutation has either persisted them or proven
  // they were already present. A CAS/network failure therefore leaves handled=false for retry.
  await Promise.all(candidates.map(({ row, lead }) => {
    const sourceId = lead.srcId ? String(lead.srcId) : (row.id != null ? String(row.id) : "");
    return sourceId && persistedSourceIds.has(sourceId) ? markHandled(row.id) : Promise.resolve();
  }));
  return res.status(200).json({ ok: true, ingested: added });
}
