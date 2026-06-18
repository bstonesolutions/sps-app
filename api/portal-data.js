// api/portal-data.js
// Server-mediated client portal data. A signed-in CLIENT calls this; we verify their Supabase
// token, then with the SERVICE-ROLE key return ONLY their own slice — their client record, their
// invoices, their schedule stops, their estimates — plus display-only config (branding, invoicing,
// and tech NAMES only). The client never receives other clients' data, the team roster's
// rates/emails/pins, costs, or profit. This is what lets app_state be locked to staff-only without
// breaking the portal (see SECURITY-RLS-PLAN.md).
import { verifyUser } from "./_auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const KEYS = ["sps_clients", "sps_invoices", "sps_schedule", "sps_estimates", "sps_branding", "sps_invoicing", "sps_team"];

const lc = (s) => String(s || "").trim().toLowerCase();

// Replicate App.jsx invoiceMatchesClient: id match, or name match when the invoice has no id.
const invoiceMatches = (iv, client) =>
  (iv.clientId != null && String(iv.clientId) === String(client.id)) ||
  (iv.clientId == null && iv.clientName && lc(iv.clientName) === lc(client.name));

// Replicate the app's schedule stop <-> client match.
const stopMatches = (s, client) =>
  String(s.id) === String(client.id) || String(s.clientId) === String(client.id) || s.client === client.name;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // This endpoint IS the security boundary — always require a verified user (not the fail-open gate).
  const user = await verifyUser(req);
  if (!user || !user.email) return res.status(401).json({ error: "Not signed in." });
  if (!SERVICE_KEY) return res.status(500).json({ error: "Server not configured (service key)." });

  const email = lc(user.email);
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?select=key,value&key=in.(${KEYS.join(",")})`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!r.ok) return res.status(502).json({ error: "Could not read portal data." });
    const rows = await r.json();
    const get = (k) => {
      const row = (rows || []).find((x) => x.key === k);
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return null; }
    };

    const clients = get("sps_clients") || [];
    const client = clients.find((c) => lc(c.email) === email) || null;
    if (!client) return res.status(200).json({ client: null }); // signed-in email isn't a client

    const invoices = (get("sps_invoices") || []).filter((iv) => invoiceMatches(iv, client));
    const schedule = (get("sps_schedule") || [])
      .map((d) => ({ ...d, stops: (d.stops || []).filter((s) => stopMatches(s, client)) }))
      .filter((d) => (d.stops || []).length > 0);
    const estimates = (get("sps_estimates") || []).filter((e) => String(e.clientId) === String(client.id));
    const branding = get("sps_branding") || {};
    const invoicing = get("sps_invoicing") || {};
    const team = (get("sps_team") || []).map((m) => ({ id: m.id, name: m.name })); // names only

    return res.status(200).json({ client, invoices, schedule, estimates, branding, invoicing, team });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Failed to load portal data." });
  }
}
