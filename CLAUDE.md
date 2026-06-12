# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Standing rules (permanent)

These rules always apply and must not be relaxed or forgotten, regardless of the task:

1. **Never modify `supabaseClient.js` or anything in the storage/database layer** unless I explicitly ask. This includes Supabase client setup, queries, schema, and any data-persistence code.

2. **Never use real business data as a fallback default.** When a value is missing or empty, default to an empty array (`[]`) — never seed defaults with real client, invoice, or business data.

3. **Always show me the change before committing or pushing.** Present the diff/edits for review and wait for my go-ahead; do not commit or push on your own.

4. **After editing `App.jsx`, always run `npm run build`** to confirm it compiles successfully before committing.

## Environment variables (set in Vercel — never hardcode)

Serverless functions under `api/` read these. None are committed; missing ones make the relevant feature degrade gracefully or return a clear error.

- `RESEND_API_KEY` — Resend API key (branded invite / magic-link / invoice emails).
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key for the admin API (minting links). Used with `RESEND_API_KEY`.
- `GUSTO_API_KEY` — Gusto API access token (Clock In/Out timesheet submission). From developer.gusto.com.
- `GUSTO_COMPANY_UUID` — Gusto company UUID. From the Gusto API or the company URL.
- `GUSTO_API_BASE` *(optional)* — Gusto API origin. Defaults to the **demo/sandbox** host `https://api.gusto-demo.com`. Set to `https://api.gusto.com` once production Gusto credentials are confirmed live.
- `VITE_GOOGLE_MAPS_API_KEY` — Google Maps key for staff location tracking, client live map + ETA, and route optimization. **Client-side** (Vite `VITE_` prefix, so it ships in the bundle — restrict it by HTTP referrer in the Google Cloud console). Enable: Maps JavaScript API, Directions API, Geocoding API, Distance Matrix API.

Optional: `SUPABASE_URL`, `RESEND_FROM`, `PUBLIC_APP_URL`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`.

## Supabase tables to create (run once in the SQL editor)

These are used via the existing `supabase` client (we never modify `supabaseClient.js`):

```sql
-- Live staff location while clocked in (one row per staff member, upserted).
CREATE TABLE staff_locations (
  staff_id   text PRIMARY KEY,
  lat        float,
  lng        float,
  updated_at timestamptz DEFAULT now(),
  is_active  boolean DEFAULT false
);
```
