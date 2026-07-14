import { verifyUser } from "./_auth.js";

const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://ysqarusrewceezckawlo.supabase.co"
).replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const cleanEmail = (value) => String(value || "").trim().toLowerCase();

function parseStoredValue(value) {
  let out = value;
  for (let i = 0; i < 2 && typeof out === "string"; i += 1) {
    try { out = JSON.parse(out); } catch { break; }
  }
  return out;
}

function activeMemberForEmail(team, email) {
  const target = cleanEmail(email);
  const matches = (Array.isArray(team) ? team : []).filter((member) => {
    if (!member || cleanEmail(member.email) !== target) return false;
    if (String(member.active ?? "true").trim().toLowerCase() === "false") return false;
    if (String(member.disabled ?? "false").trim().toLowerCase() === "true") return false;
    return !["disabled", "inactive", "revoked"].includes(String(member.status || "").trim().toLowerCase());
  });
  return matches.length === 1 ? matches[0] : null;
}

export function memberCanSendEstimates(member) {
  if (!member) return false;
  if (String(member.role || "").trim().toLowerCase() === "owner") return true;
  const fine = member.fine && typeof member.fine === "object" ? member.fine : {};
  // Estimate sending historically shares the existing invoiceSend action switch in the
  // staff editor. Keep honoring that switch at the API boundary so a disabled button cannot
  // be bypassed by calling this endpoint directly. A future dedicated estimateSend switch is
  // also respected if one is introduced later.
  if (fine.invoiceSend === false || fine.estimateSend === false) return false;

  const tabAccess = member.tabAccess && typeof member.tabAccess === "object" ? member.tabAccess : null;
  if (tabAccess) return String(tabAccess.estimates || "hidden") === "edit";

  const legacyPerms = member.perms && typeof member.perms === "object" ? member.perms : {};
  if (legacyPerms.canInvoice !== undefined) return !!legacyPerms.canInvoice;
  if (member.canInvoice !== undefined) return !!member.canInvoice;
  return ["full", "lead"].includes(String(member.role || "field").trim().toLowerCase());
}

async function loadTeam() {
  if (!SERVICE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.sps_team&select=value`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!response.ok) throw new Error(`team lookup failed (${response.status})`);
  const rows = await response.json().catch(() => null);
  const team = Array.isArray(rows) && rows[0] ? parseStoredValue(rows[0].value) : null;
  if (!Array.isArray(team)) throw new Error("sps_team is missing or malformed");
  return team;
}

export async function requireEstimateSender(req, res) {
  const user = await verifyUser(req);
  if (!user || !user.email) {
    res.status(401).json({ error: "Please sign in again to send estimates." });
    return null;
  }
  try {
    const member = activeMemberForEmail(await loadTeam(), user.email);
    if (member && memberCanSendEstimates(member)) return { ...user, teamMember: member };
    res.status(403).json({ error: "Your team permissions do not allow sending estimates." });
    return null;
  } catch (error) {
    console.error("[estimate-auth] authorization unavailable:", error && error.message ? error.message : error);
    res.status(503).json({ error: "Estimate authorization is temporarily unavailable. Please try again." });
    return null;
  }
}
