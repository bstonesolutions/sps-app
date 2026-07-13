// Non-QuickBooks authorization for privileged SPS application routes.
//
// Identity verification intentionally stays in the existing _auth.js so build 28 keeps its
// established token handling. Team membership and action authorization live here, isolated from
// every QuickBooks import path. A valid Supabase account is not enough: client-portal users are
// Supabase users too, so the caller must match exactly one active member of the protected team row.
import { verifyUser } from "./_auth.js";

const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://ysqarusrewceezckawlo.supabase.co"
).replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const cleanEmail = (value) => String(value || "").trim().toLowerCase();

function parseStoredValue(value) {
  let parsed = value;
  // Older app_state rows can contain a JSON string inside JSONB; tolerate both representations.
  for (let i = 0; i < 2 && typeof parsed === "string"; i += 1) {
    try { parsed = JSON.parse(parsed); } catch { break; }
  }
  return parsed;
}

function serviceHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
}

class StaffAuthorizationUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "StaffAuthorizationUnavailableError";
  }
}

async function loadTeam() {
  if (!SERVICE_KEY) throw new StaffAuthorizationUnavailableError("SUPABASE_SERVICE_ROLE_KEY is not configured");
  let response;
  try {
    response = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?key=eq.sps_team&select=value`,
      { headers: serviceHeaders() },
    );
  } catch (error) {
    throw new StaffAuthorizationUnavailableError(`team lookup failed: ${error && error.message ? error.message : "network error"}`);
  }
  if (!response.ok) throw new StaffAuthorizationUnavailableError(`team lookup failed (${response.status})`);
  const rows = await response.json().catch(() => null);
  const team = Array.isArray(rows) && rows[0] ? parseStoredValue(rows[0].value) : null;
  if (!Array.isArray(team)) throw new StaffAuthorizationUnavailableError("sps_team is missing or malformed");
  return team;
}

function activeMemberForEmail(team, email) {
  const key = cleanEmail(email);
  if (!key) return null;
  const matches = (team || []).filter((member) => {
    if (!member || cleanEmail(member.email) !== key) return false;
    if (String(member.active ?? "true").trim().toLowerCase() === "false") return false;
    if (String(member.disabled ?? "false").trim().toLowerCase() === "true") return false;
    return !["disabled", "inactive", "revoked"].includes(String(member.status || "").trim().toLowerCase());
  });
  // Duplicate emails make identity and role resolution ambiguous. Never pick the first one.
  return matches.length === 1 ? matches[0] : null;
}

function tabMode(member, tab) {
  const access = member && member.tabAccess;
  if (!access || typeof access !== "object") return null;
  if (access[tab]) return String(access[tab]);
  // App.jsx folded the old Messages and Reminders tabs into Comms. Mirror that migration here so
  // a still-valid legacy roster does not silently lose server permission to send business texts.
  if (tab === "comms" && (access.messages || access.reminders)) {
    const rank = { hidden: 0, view: 1, edit: 2 };
    return [access.messages, access.reminders]
      .filter(Boolean)
      .reduce((best, mode) => ((rank[mode] || 0) > (rank[best] || 0) ? mode : best), "hidden");
  }
  return "hidden";
}

function legacyFlag(member, ...names) {
  const permissions = member && member.perms && typeof member.perms === "object" ? member.perms : {};
  for (const name of names) {
    if (permissions[name] !== undefined) return !!permissions[name];
    if (member && member[name] !== undefined) return !!member[name];
  }
  return null;
}

// Server mirror of App.jsx action permissions. The tab mode is the master switch so a stale
// fine-grained flag cannot restore an action hidden by a read-only or hidden tab.
export function memberHasCapability(member, capability) {
  if (!member) return false;
  const role = String(member.role || "field").trim().toLowerCase();
  if (role === "owner") return true;
  const fine = member.fine && typeof member.fine === "object" ? member.fine : {};

  if (capability === "invoiceView") {
    const mode = tabMode(member, "invoices");
    if (mode !== null) return mode === "view" || mode === "edit";
    const explicit = legacyFlag(member, "canViewInvoices", "viewInvoices");
    if (explicit !== null) return explicit;
    return ["full", "lead", "viewer"].includes(role);
  }

  const invoiceFine = {
    invoiceCreate: "invoiceCreate",
    invoiceSend: "invoiceSend",
    invoiceMarkPaid: "invoiceMarkPaid",
    invoiceDelete: "invoiceDelete",
  };
  if (invoiceFine[capability]) {
    const mode = tabMode(member, "invoices");
    let base;
    if (mode !== null) base = mode === "edit";
    else {
      const explicit = legacyFlag(member, "canInvoice");
      base = explicit !== null ? explicit : ["full", "lead"].includes(role);
    }
    return !!base && fine[invoiceFine[capability]] !== false;
  }

  if (capability === "sendTexts") {
    const schedule = tabMode(member, "schedule");
    const comms = tabMode(member, "comms");
    if (schedule !== null || comms !== null) return schedule === "edit" || comms === "edit";
    const explicit = legacyFlag(member, "canSendTexts", "sendTexts");
    if (explicit !== null) return explicit;
    return ["full", "lead", "field", "staff"].includes(role);
  }

  if (capability === "completeStops") {
    const schedule = tabMode(member, "schedule");
    if (schedule !== null) return schedule === "edit";
    const explicit = legacyFlag(member, "canCompleteStops", "completeStops");
    if (explicit !== null) return explicit;
    return role === "custom" || ["full", "lead", "field", "staff"].includes(role);
  }

  return false;
}

export async function resolveStaffUser(user) {
  if (!user || !user.id || !user.email) return null;
  const team = await loadTeam();
  const member = activeMemberForEmail(team, user.email);
  if (!member) return null;
  return { ...user, teamMember: member, teamRole: String(member.role || "field").trim().toLowerCase() };
}

function authorizationUnavailable(res) {
  res.status(503).json({ error: "Authorization is temporarily unavailable. Please try again." });
  return null;
}

export async function requireStaff(req, res, feature = "this action") {
  const user = await verifyUser(req);
  if (!user || !user.email) {
    res.status(401).json({ error: "Please sign in again to do that." });
    return null;
  }
  try {
    const staff = await resolveStaffUser(user);
    if (staff) return staff;
    res.status(403).json({ error: `An active SPS team account is required for ${feature}.` });
    return null;
  } catch (error) {
    console.error("[staff-auth] authorization unavailable:", error && error.message ? error.message : error);
    return authorizationUnavailable(res);
  }
}

export async function requireOwner(req, res, feature = "this action") {
  const staff = await requireStaff(req, res, feature);
  if (!staff) return null;
  if (staff.teamRole === "owner") return staff;
  res.status(403).json({ error: `Owner access is required for ${feature}.` });
  return null;
}

export async function requireCapability(req, res, capability, feature = "this action") {
  const staff = await requireStaff(req, res, feature);
  if (!staff) return null;
  if (memberHasCapability(staff.teamMember, capability)) return staff;
  res.status(403).json({ error: `Your team permissions do not allow ${feature}.` });
  return null;
}
