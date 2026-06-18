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

### `API_AUTH_ENFORCED` — turning on endpoint auth (two-step, safe rollout)

The privileged `api/` endpoints (send-sms/-invoice/-notification/-auth-email/-magic-link, QuickBooks
writers + sync/accounts) verify the caller's Supabase token via `api/_auth.js`. **Enforcement is OFF
by default** so a deploy can't break sending: an unauthenticated call is *allowed and logged*
(`[auth] unauthenticated call (enforcement off)`) unless `API_AUTH_ENFORCED === "true"`.

To turn it on safely:
1. Deploy (the app already attaches `Authorization: Bearer <session token>` on every api call).
2. Exercise each flow once (send a test text/email, sync QB, record a payment) and watch the Vercel
   function logs. Authenticated calls log nothing; any path still missing a token logs the warning
   above with its URL — tell Claude that path and it'll attach the token there.
3. Once the warnings stop, set `API_AUTH_ENFORCED=true` in Vercel. Now unauthenticated calls get a
   401. To roll back instantly, unset it.

## Supabase tables to create (run once in the SQL editor)

These are used via the existing `supabase` client (we never modify `supabaseClient.js`):

```sql
-- Live staff location while clocked in (one row per staff member, upserted).
CREATE TABLE IF NOT EXISTS public.staff_locations (
  staff_id   text PRIMARY KEY,
  lat        float,
  lng        float,
  updated_at timestamptz DEFAULT now(),
  is_active  boolean DEFAULT false
);
-- RLS on (same posture as app_state): signed-in users only; the shipped anon key gets nothing.
ALTER TABLE public.staff_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff_locations read (authenticated)"
  ON public.staff_locations FOR SELECT TO authenticated USING (true);
CREATE POLICY "staff_locations insert (authenticated)"
  ON public.staff_locations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "staff_locations update (authenticated)"
  ON public.staff_locations FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
```

## Supabase Realtime (run once in the SQL editor)

The app subscribes to live changes on `app_state` (client comm prefs, arrivals, completed) and
`staff_locations` (tech live map). **Realtime is per-TABLE, not per-key** — every key in
`app_state` (`sps_clients`, `sps_arrivals`, `sps_completed`, …) rides the one publication, so this
covers current and future key-based subscriptions. Idempotent — safe to re-run:

```sql
do $$
begin
  -- app_state powers client comm prefs + arrivals/completed (always present).
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='app_state') then
    alter publication supabase_realtime add table public.app_state;
  end if;
  alter table public.app_state replica identity full;

  -- staff_locations only exists once you've created it (tech live-map; see table SQL above).
  -- Guarded on existence so this block never fails when that feature isn't set up yet.
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='staff_locations') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='staff_locations') then
      alter publication supabase_realtime add table public.staff_locations;
    end if;
    alter table public.staff_locations replica identity full;
  end if;
end $$;

-- Verify (app_state always listed; staff_locations too, once it exists):
select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename;
```

Realtime also respects RLS — the authenticated client must be able to `SELECT` the table for
events to arrive (already the case, since arrivals/locations sync works today).
