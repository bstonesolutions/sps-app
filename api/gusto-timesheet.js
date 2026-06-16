// api/gusto-timesheet.js
// Submits a completed staff shift to Gusto as a time-tracking time sheet.
// Server-side only — Gusto credentials are read from environment variables and
// never exposed to the client.
//
// POST body:
//   {
//     employeeUuid:   string,  // Gusto employee UUID for this staff member
//     shiftStartedAt: string,  // ISO 8601 datetime, e.g. "2026-06-12T09:00:00Z"
//     shiftEndedAt:   string,  // ISO 8601 datetime
//     hoursWorked:    number,  // decimal hours (already calculated client-side)
//     jobUuid:        string,  // optional — Gusto job UUID if configured
//   }
//
// Required env (set in Vercel, never hardcoded):
//   GUSTO_API_KEY        - Gusto API access token
//   GUSTO_COMPANY_UUID   - Gusto company UUID
// Optional env:
//   GUSTO_API_BASE       - API origin. Defaults to the DEMO/sandbox host
//                          (https://api.gusto-demo.com). Set this to
//                          https://api.gusto.com once production creds are live.

const GUSTO_API_VERSION = "2024-04-01";
// Default to the sandbox host until production credentials are confirmed.
const GUSTO_BASE = (process.env.GUSTO_API_BASE || "https://api.gusto-demo.com").replace(/\/+$/, "");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  // Health check — GET reports whether the credentials are configured, WITHOUT
  // exposing any secret values. Visit /api/gusto-timesheet to confirm setup.
  if (req.method === "GET" || (req.query && req.query.check)) {
    return res.status(200).json({
      ok: true,
      endpoint: "gusto-timesheet",
      configured: {
        apiKey: !!process.env.GUSTO_API_KEY,
        companyUuid: !!process.env.GUSTO_COMPANY_UUID,
      },
      apiBase: GUSTO_BASE,
      apiVersion: GUSTO_API_VERSION,
      mode: GUSTO_BASE.includes("gusto-demo") ? "demo" : "production",
    });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const { employeeUuid, shiftStartedAt, shiftEndedAt, hoursWorked, jobUuid } = req.body || {};

  // Validate input before reaching out to Gusto.
  if (!employeeUuid) return res.status(400).json({ ok: false, error: "employeeUuid is required" });
  if (!shiftStartedAt || !shiftEndedAt) return res.status(400).json({ ok: false, error: "shiftStartedAt and shiftEndedAt are required" });

  const API_KEY      = process.env.GUSTO_API_KEY;
  const COMPANY_UUID = process.env.GUSTO_COMPANY_UUID;

  // Never silently fail — tell the client exactly what's missing.
  if (!API_KEY) return res.status(501).json({ ok: false, error: "GUSTO_API_KEY is not set on the server. Add it in Vercel to enable Gusto timesheet submission.", missingEnv: true });
  if (!COMPANY_UUID) return res.status(501).json({ ok: false, error: "GUSTO_COMPANY_UUID is not set on the server. Add it in Vercel to enable Gusto timesheet submission.", missingEnv: true });

  const url = `${GUSTO_BASE}/v1/companies/${COMPANY_UUID}/time_tracking/time_sheets`;

  // Map the completed shift to Gusto's time-sheet shape. The exact field names
  // can be tuned against the Gusto sandbox; we forward Gusto's raw response so
  // any schema mismatch is visible during testing rather than silently dropped.
  const payload = {
    employee_uuid: employeeUuid,
    start_time: shiftStartedAt,
    end_time: shiftEndedAt,
    hours: typeof hoursWorked === "number" ? hoursWorked : Number(hoursWorked) || 0,
    ...(jobUuid ? { job_uuid: jobUuid } : {}),
  };

  try {
    const gustoRes = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "X-Gusto-API-Version": GUSTO_API_VERSION,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await gustoRes.json().catch(() => ({}));

    if (!gustoRes.ok) {
      const detail = data?.errors?.[0]?.message || data?.message || data?.error || `Gusto returned ${gustoRes.status}`;
      return res.status(502).json({ ok: false, error: `Gusto rejected the timesheet: ${detail}`, status: gustoRes.status, details: data });
    }

    return res.status(200).json({ ok: true, timeSheet: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Failed to submit timesheet to Gusto" });
  }
}
