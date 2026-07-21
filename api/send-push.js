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
import { memberHasCapability, resolveStaffUser } from "./_staff-auth.js";
import { readAppState, resolvePortalClient } from "./_portal-auth.js";
import { pushConfigured, pushOwner, pushClient, pushStaff } from "./_push.js";

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

const EVENTS = {
  stop_completed:  { aud: "owner", prefKey: "stop_completed",  link: "schedule", title: "Stop completed", staffCapability: "completeStops" },
  office_alert:    { aud: "owner", prefKey: "office_alert",    link: "alerts",   title: "Note from the field", staffCapability: "completeStops" },
  service_request: { aud: "owner", prefKey: "service_request", link: "alerts",   title: "Service request", clientAllowed: true },
  low_rating:      { aud: "owner", prefKey: "low_rating",      link: "alerts",   title: "Visit feedback", clientAllowed: true },
  upgrade_request: { aud: "owner", prefKey: "upgrade_request", link: "alerts",   title: "Upgrade request", clientAllowed: true },
  invoice_paid:    { aud: "owner", prefKey: "payment_received", link: "invoices", title: "Invoice paid", staffCapability: "invoiceMarkPaid" },
  new_invoice:     { aud: "client", link: "invoices", title: "New invoice", staffCapability: "invoiceSend" },
  stop_assigned:   { aud: "staff",  link: "schedule", title: "New stop on your schedule", staffCapability: "scheduleAddRemove", recipientCapability: "completeStops" },
};

function canAddRemoveSchedule(member) {
  if (!member) return false;
  const role = String(member.role || "field").trim().toLowerCase();
  if (role === "owner") return true;
  const fine = member.fine && typeof member.fine === "object" ? member.fine : {};
  const access = member.tabAccess && typeof member.tabAccess === "object" ? member.tabAccess : null;
  let base;
  if (access) base = String(access.schedule || "hidden") === "edit";
  else if (member.perms && typeof member.perms === "object" && member.perms.canEditSchedule !== undefined) base = !!member.perms.canEditSchedule;
  else if (member.canEditSchedule !== undefined) base = !!member.canEditSchedule;
  else base = ["full", "lead"].includes(role);
  return base && fine.scheduleAddRemove !== false;
}

function staffCanRaiseEvent(member, capability) {
  if (!capability) return false;
  if (capability === "scheduleAddRemove") return canAddRemoveSchedule(member);
  return memberHasCapability(member, capability);
}

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
  let callerRole = "", callerStaff = null;
  try {
    const staff = await resolveStaffUser(user);
    if (staff) {
      callerStaff = staff;
      callerRole = staff.teamRole === "owner" ? "owner" : "staff";
    }
    else {
      const clients = await readAppState("sps_clients");
      if (resolvePortalClient(clients, user).client) callerRole = "client";
    }
  } catch (_) {
    return res.status(503).json({ error: "Authorization is temporarily unavailable." });
  }
  if (!callerRole) return res.status(403).json({ error: "This account isn't on the team or client list." });
  if (callerRole === "client" && !ev.clientAllowed) {
    return res.status(403).json({ error: "Not allowed for this account." });
  }
  if (callerRole === "staff" && !staffCanRaiseEvent(callerStaff?.teamMember, ev.staffCapability)) {
    return res.status(403).json({ error: "Your team permissions do not allow this notification." });
  }

  // Client callers may select only a fixed, explicitly client-allowed event. Do not let portal
  // input replace the lock-screen heading with arbitrary text.
  const title = callerRole === "client" ? ev.title : (clean(b.title, 120) || ev.title);
  const body = clean(b.body, 220);
  const collapseId = clean(b.collapseId, 60) || undefined;

  let out;
  if (ev.aud === "owner") out = await pushOwner(ev.prefKey, title, body, ev.link, { collapseId });
  else if (ev.aud === "client") out = await pushClient(clean(b.clientId, 60), title, body, ev.link, { collapseId });
  else out = await pushStaff(clean(b.staffId, 60), title, body, ev.link, {
    collapseId,
    requiredCapability: ev.recipientCapability,
  });

  return res.status(200).json(out);
}
