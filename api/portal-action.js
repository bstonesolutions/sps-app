// api/portal-action.js
// Server-mediated client WRITES. A signed-in client performs a small allowlist of actions on THEIR
// OWN data: save comm prefs, approve their estimate, rate a visit, or raise a staff alert (service
// request / upgrade request / low rating). We verify the token + ownership, then apply a TARGETED
// change with the service-role key — never a whole-array write from the client's device (which,
// once app_state is locked and the device's local copy is empty, would wipe the table). This +
// api/portal-data are what let app_state be locked to staff-only. See SECURITY-RLS-PLAN.md.
import { verifyUser } from "./_auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const lc = (s) => String(s || "").trim().toLowerCase();

async function readKey(key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?select=value&key=eq.${key}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  const row = rows && rows[0];
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
async function writeKey(key, value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }),
  });
  return r.ok;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyUser(req);
  if (!user || !user.email) return res.status(401).json({ error: "Not signed in." });
  if (!SERVICE_KEY) return res.status(500).json({ error: "Server not configured (service key)." });

  const { action, payload } = req.body || {};
  const email = lc(user.email);
  const clients = (await readKey("sps_clients")) || [];
  const client = clients.find((c) => lc(c.email) === email);
  if (!client) return res.status(403).json({ error: "Not a client." });

  try {
    if (action === "savePrefs") {
      const notifyPrefs = (payload && payload.notifyPrefs) || {};
      const next = clients.map((c) => (String(c.id) === String(client.id) ? { ...c, notifyPrefs } : c));
      return res.status((await writeKey("sps_clients", next)) ? 200 : 502).json({ ok: true });
    }

    if (action === "approveEstimate") {
      const ests = (await readKey("sps_estimates")) || [];
      // Only touch an estimate that is THIS client's.
      const next = ests.map((e) =>
        String(e.id) === String(payload && payload.id) && String(e.clientId) === String(client.id)
          ? { ...e, status: payload.status }
          : e
      );
      return res.status((await writeKey("sps_estimates", next)) ? 200 : 502).json({ ok: true });
    }

    if (action === "rateVisit") {
      const { visitDate, rating, feedback } = payload || {};
      const next = clients.map((c) => {
        if (String(c.id) !== String(client.id)) return c;
        const hist = (c.history || []).slice();
        const idx = visitDate ? hist.findIndex((h) => h.date === visitDate) : 0;
        const at = idx >= 0 ? idx : 0;
        if (hist[at]) hist[at] = { ...hist[at], clientRating: rating, clientFeedback: feedback || "", ratedAt: Date.now() };
        return { ...c, history: hist };
      });
      return res.status((await writeKey("sps_clients", next)) ? 200 : 502).json({ ok: true });
    }

    if (action === "officeAlert") {
      const a = (payload && payload.alert) || null;
      if (!a) return res.status(400).json({ error: "Missing alert." });
      const alerts = (await readKey("sps_officeAlerts")) || [];
      // Force the verified client identity so a client can't forge an alert as another client.
      const alert = { id: Date.now(), resolved: false, ...a, clientId: client.id, clientName: client.name };
      return res.status((await writeKey("sps_officeAlerts", [alert, ...alerts])) ? 200 : 502).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Action failed." });
  }
}
