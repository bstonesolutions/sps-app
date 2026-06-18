// api/_auth.js
// Caller authentication for the privileged serverless endpoints (sending email/SMS, writing to
// QuickBooks). The app attaches `Authorization: Bearer <supabase access_token>` (the owner/tech is
// always signed in); we validate it against Supabase's /auth/v1/user.
//
// SAFETY — enforcement is OFF by default. Deploying this can never break live sends: an
// unauthenticated call is ALLOWED (and logged) unless API_AUTH_ENFORCED === "true". Flip that
// Vercel env var to "true" only AFTER confirming the app sends with tokens attached (the app does,
// as of this change). Then unauthenticated calls get a 401.
//
// The URL + anon key are public (already in the client bundle), so the fallback exposes nothing new.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
// Any valid project key works as the apikey for /auth/v1/user; the Bearer token identifies the user.
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzcWFydXNyZXdjZWV6Y2thd2xvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MjkzODEsImV4cCI6MjA5NjIwNTM4MX0.GCX-Bt3sSoDaaF-XT2xeu4h6wR4tXO2hqOydQUkl_CQ";

// Resolve the Supabase user from the request's Bearer token, or null.
export async function verifyUser(req) {
  const hdr = req.headers.authorization || req.headers.Authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY },
    });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    return u && u.id ? u : null;
  } catch (_) {
    return null;
  }
}

// Gate a handler. On success returns the user. If unauthenticated AND enforcement is on, sends a
// 401 and returns null (the handler must `return` when null). If enforcement is off, allows the
// call (logs a warning) so a deploy can't break sends before the env var is flipped.
export async function requireUser(req, res) {
  const user = await verifyUser(req);
  if (user) return user;
  if (process.env.API_AUTH_ENFORCED === "true") {
    res.status(401).json({ error: "Please sign in again to do that." });
    return null;
  }
  try { console.warn("[auth] unauthenticated call (enforcement off):", req.url || ""); } catch (_) {}
  return { id: "anon", enforcementOff: true };
}
