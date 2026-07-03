// api/leads-sync.js
// The website→app leads bridge. The marketing site (sps-website) writes quote-form submissions to
// ITS OWN Supabase project's `leads` table (anon insert, owner-only read) — this endpoint lets the
// app pull those rows into the in-app funnel (sps_leads → Comms → Leads → one-tap convert).
//
// TWO-PHASE so a lead can never be lost mid-import:
//   POST {}                → up to 200 rows with handled=false (oldest first). Nothing is mutated.
//   POST {imported:[ids]}  → AFTER the app has saved them into sps_leads, mark those rows
//                            handled=true so they never re-import. (`handled` = "imported to app".)
//   GET ?check             → { configured } for the Sync tab.
//
// OWNER-ONLY (the Leads screen is owner-only). Ships dark until the env vars are set:
//   WEBSITE_SUPABASE_URL          — the WEBSITE project's URL (https://<ref>.supabase.co)
//   WEBSITE_SUPABASE_SERVICE_KEY  — that project's service-role key (server-only, bypasses RLS)

import { requireOwner } from "./plaid/_plaid.js";

const SITE_URL = process.env.WEBSITE_SUPABASE_URL;
const SITE_KEY = process.env.WEBSITE_SUPABASE_SERVICE_KEY;
const configured = () => !!(SITE_URL && SITE_KEY);
const headers = () => ({ apikey: SITE_KEY, Authorization: `Bearer ${SITE_KEY}`, "Content-Type": "application/json" });

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || (req.query && req.query.check)) return res.status(200).json({ ok: true, configured: configured() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const u = await requireOwner(req, res, "the leads bridge"); if (!u) return;
  if (!configured()) return res.status(501).json({ error: "Leads bridge isn't set up — add WEBSITE_SUPABASE_URL + WEBSITE_SUPABASE_SERVICE_KEY in Vercel.", missingEnv: true });

  const b = req.body || {};

  // Phase 2 — acknowledge: the app saved these into sps_leads; mark them imported. Strict UUIDs
  // only (one malformed value would 400 the whole in.() filter), chunked so a single bad chunk
  // can't void the rest — unacked rows just re-import next open and dedupe.
  if (Array.isArray(b.imported) && b.imported.length) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = b.imported.filter((s) => UUID.test(String(s))).slice(0, 200);
    if (!ids.length) return res.status(400).json({ error: "no valid ids" });
    let marked = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        const r = await fetch(`${SITE_URL}/rest/v1/leads?id=in.(${chunk.join(",")})`, {
          method: "PATCH", headers: headers(), body: JSON.stringify({ handled: true }),
        });
        if (r.ok) marked += chunk.length;
      } catch (_) { /* soft-fail per chunk */ }
    }
    return res.status(200).json({ ok: true, marked });
  }

  // Phase 1 — fetch: everything not yet imported, oldest first.
  try {
    // select=* so schema additions on the website side (e.g. the photos column) never 400 the
    // bridge — the app picks the fields it knows and passes extras like photos through.
    const r = await fetch(`${SITE_URL}/rest/v1/leads?handled=eq.false&order=created_at.asc&limit=200&select=*`, { headers: headers() });
    if (!r.ok) return res.status(502).json({ error: `Couldn't read the website leads (${r.status})` });
    const rows = await r.json().catch(() => []);
    return res.status(200).json({ ok: true, leads: Array.isArray(rows) ? rows : [] });
  } catch (e) { return res.status(502).json({ error: e.message || "Couldn't reach the website database" }); }
}
