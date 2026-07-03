// api/send-push.js — the app's one door for event pushes (Build 27).
//
// POST {event, title?, body?, clientId?, staffId?} → the server decides WHO gets pushed from
// the event's fixed audience + stored sps_push_tokens; the caller can never name raw device
// tokens. UNLIKE the legacy endpoints, auth here is enforced UNCONDITIONALLY (no
// API_AUTH_ENFORCED escape hatch): this endpoint is brand-new, its only caller already
// attaches the session token, and title/body are caller-controlled — an open door would be a
// lock-screen spam/phishing vector. Callers are also ROLE-GATED: only team members (owner/
// staff) may fire staff- or client-audience events; a signed-in client may only raise the
// three owner alerts their own portal actions produce. Test Mode + the owner's per-event
// Push toggles are enforced inside _push.js. GET ?check → configured booleans.
//
// Events (fixed audience → deep-link target):
//   stop_completed  → owner   → schedule     "Stop completed at <client>"
//   office_alert    → owner   → alerts       tech flag / service request / low rating / upgrade
//   invoice_paid    → owner   → invoices     (prefs key payment_received — same toggle as email)
//   new_invoice     → client  → invoices     (portal routes to cp_invoices)
//   stop_assigned   → staff   → schedule     "New stop on your schedule"

import { verifyUser } from "./_auth.js";
import { pushConfigured, pushOwner, pushClient, pushStaff, resolveCallerRole } from "./_push.js";

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

const EVENTS = {
  stop_completed:  { aud: "owner", prefKey: "stop_completed",  link: "schedule", title: "Stop completed" },
  office_alert:    { aud: "owner", prefKey: "office_alert",    link: "alerts",   title: "Note from the field" },
  service_request: { aud: "owner", prefKey: "service_request", link: "alerts",   title: "Service request" },
  low_rating:      { aud: "owner", prefKey: "low_rating",      link: "alerts",   title: "Visit feedback" },
  upgrade_request: { aud: "owner", prefKey: "upgrade_request", link: "alerts",   title: "Upgrade request" },
  invoice_paid:    { aud: "owner", prefKey: "payment_received", link: "invoices", title: "Invoice paid" },
  new_invoice:     { aud: "client", link: "invoices", title: "New invoice" },
  stop_assigned:   { aud: "staff",  link: "schedule", title: "New stop on your schedule" },
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, configured: { apns: pushConfigured() } });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const user = await verifyUser(req);
  if (!user || !user.email) return res.status(401).json({ error: "Please sign in again." });

  const b = req.body || {};
  const ev = EVENTS[String(b.event || "")];
  if (!ev) return res.status(400).json({ error: "Unknown event." });
  if (!pushConfigured()) return res.status(200).json({ ok: false, skipped: "APNs isn't configured yet — add the APNS_* keys in Vercel." });

  // Role gate: clients may only raise the owner alerts their own portal actions legitimately
  // produce (legacy non-server-mode portals call this directly); everything else needs a team
  // member. An email on neither list gets nothing.
  const CLIENT_OK = ["service_request", "low_rating", "upgrade_request"];
  const callerRole = await resolveCallerRole(user.email);
  if (!callerRole) return res.status(403).json({ error: "This account isn't on the team or client list." });
  if (callerRole === "client" && !CLIENT_OK.includes(String(b.event))) {
    return res.status(403).json({ error: "Not allowed for this account." });
  }

  const title = clean(b.title, 120) || ev.title;
  const body = clean(b.body, 220);
  const collapseId = clean(b.collapseId, 60) || undefined;

  let out;
  if (ev.aud === "owner") out = await pushOwner(ev.prefKey, title, body, ev.link, { collapseId });
  else if (ev.aud === "client") out = await pushClient(clean(b.clientId, 60), title, body, ev.link, { collapseId });
  else out = await pushStaff(clean(b.staffId, 60), title, body, ev.link, { collapseId });

  return res.status(200).json(out);
}
