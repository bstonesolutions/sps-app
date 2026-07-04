# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Standing rules (permanent)

These rules always apply and must not be relaxed or forgotten, regardless of the task:

1. **Never modify `supabaseClient.js` or anything in the storage/database layer** unless I explicitly ask. This includes Supabase client setup, queries, schema, and any data-persistence code.

2. **Never use real business data as a fallback default.** When a value is missing or empty, default to an empty array (`[]`) — never seed defaults with real client, invoice, or business data.

3. **Always show me the change before committing or pushing.** Present the diff/edits for review and wait for my go-ahead; do not commit or push on your own.

4. **After editing `App.jsx`, always run `npm run build`** to confirm it compiles successfully before committing.

5. **Match the existing app aesthetic on every change — by default, without being asked.** New UI must reuse the app's established design system: the theme tokens (`T.primary`, `T.surface`, `T.surfaceAlt`, `T.border`, `T.text`, `T.textMuted`, `T.accent`, `hexA(...)`), the standard chip/button/input/label/`Modal` styles already used elsewhere (e.g. the Products Purchased / Assigned To selectable chips, the `Btn` component, the shared `field`/`labelStyle`), matching radii, spacing, font weights, and iconography. Do not introduce a new look, new colors, or one-off styling. When I ask to "tweak" or "change" something, assume I mean an adjustment **within** that aesthetic — usually making it more (or less) prominent, not a redesign — unless I explicitly say otherwise.

## Environment variables (set in Vercel — never hardcode)

Serverless functions under `api/` read these. None are committed; missing ones make the relevant feature degrade gracefully or return a clear error.

- `RESEND_API_KEY` — Resend API key (branded invite / magic-link / invoice emails).
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key for the admin API (minting links). Used with `RESEND_API_KEY`.
- `GUSTO_API_KEY` — Gusto API access token (Clock In/Out timesheet submission). From developer.gusto.com.
- `GUSTO_COMPANY_UUID` — Gusto company UUID. From the Gusto API or the company URL.
- `GUSTO_API_BASE` *(optional)* — Gusto API origin. Defaults to the **demo/sandbox** host `https://api.gusto-demo.com`. Set to `https://api.gusto.com` once production Gusto credentials are confirmed live.
- `VITE_GOOGLE_MAPS_API_KEY` — Google Maps key for staff location tracking, client live map + ETA, and route optimization. **Client-side** (Vite `VITE_` prefix, so it ships in the bundle — restrict it by HTTP referrer in the Google Cloud console). Enable: Maps JavaScript API, Directions API, Geocoding API, Distance Matrix API.
- `QUO_API_KEY`, `QUO_PHONE_NUMBER` — Quo (ex-OpenPhone) API key + the business texting number (E.164). Power every outbound SMS (`api/send-sms.js` and the automation cron).
- `CRON_SECRET` — **required to ACTIVATE automated sending.** The `api/cron-automations` scheduler (Vercel cron, hourly per `vercel.json`) only performs REAL sends when the request carries `Authorization: Bearer <CRON_SECRET>` — which Vercel attaches automatically once this env var is set. Without it, the cron 401s on real runs (so nothing sends) while the app's **dry-run preview** (`?dryRun=1`) still works. Set any long random string. The whole engine is *also* gated by the in-app master switch (`sps_schedule_cfg.schedulerOn`) + Test Mode, so setting this alone does not send anything until the owner turns it on.
- `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` — Plaid bank sync (real transactions in Budget → Bank + the Customize "Bank Sync" card). `PLAID_ENV` = `sandbox` (test banks, instant) or `production` (real banks, needs Plaid production approval); the secret is PER-ENVIRONMENT — swap it when flipping envs. Ships dark until set. Requires the `plaid_tokens` table (SQL below). Data endpoints are owner-only.
- `ANTHROPIC_API_KEY` — **the ONLY thing needed to turn on the AI features.** Powers the AI helpers in `api/_ai.js` → `api/ai-summarize.js` (client visit recap) and `api/ai-water-diagnosis.js` (water-test analysis + treatment/upsell suggestions), surfaced on the stop-completion screen's "✨ AI assist". Until it's set, the AI buttons show a clean "AI isn't connected yet — add your key" message and nothing else breaks. Get it at console.anthropic.com. Optional `ANTHROPIC_MODEL` overrides the default `claude-sonnet-4-6`.
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` — **native push notifications (Build 27+).** From an APNs Auth Key (.p8) created at developer.apple.com → Certificates, Identifiers & Profiles → Keys (enable "Apple Push Notifications service"): `APNS_KEY_ID` = the key's 10-char id, `APNS_TEAM_ID` = `JASPHFVN38`, `APNS_PRIVATE_KEY` = the .p8 file contents (PEM — newlines preserved or `\n`-escaped both work). Optional: `APNS_BUNDLE_ID` (defaults to `com.stonepropertysolutions.app`) and `APNS_HOST` (defaults to production `https://api.push.apple.com`; set `https://api.sandbox.push.apple.com` ONLY while testing an Xcode debug build — debug builds mint sandbox tokens and each host rejects the other's with BadDeviceToken). Ships dark until set: `api/_push.js` no-ops, endpoints report `configured:{apns:false}`, nothing breaks. Requires the `sps_push_tokens` table (SQL below). Safety: Test Mode restricts ALL pushes to owner-role devices; owner pushes honor the per-event Push toggles in Comms → Settings.
- `MSG_WEBHOOK_SECRET` — Bearer secret for `api/message-intake.js` (the sps_messages INSERT webhook that turns chat messages into pushes: client → owner "New message", staff → client "New message / New invoice / Service report"). Falls back to `LEAD_WEBHOOK_SECRET` so one secret can serve both intakes. Wire-up SQL below.
- `GMAIL_IMAP_USER`, `GMAIL_IMAP_PASSWORD` — **Gmail history import** (`api/gmail-backfill.js`, Comms → Email → "Import Gmail"). Pulls the owner's EXISTING mail into `sps_inbox` alongside forwarded new mail, AI-sorted, marked read, original dates, no pushes. `GMAIL_IMAP_USER` = the address (brandon@stonepropertysolutions.com); `GMAIL_IMAP_PASSWORD` = a **Google App Password** (16 chars, from myaccount.google.com/apppasswords — requires 2-Step Verification on the account; NOT the normal password, and NOT OAuth which needs restricted-scope review). Owner-only endpoint (requireOwner), paged (app loops offset), ships dark until both set. IMAP must be enabled in Gmail settings (default on for Workspace).
- `INBOUND_WEBHOOK_SECRET` — the work-email funnel (`api/inbound-email.js`). The owner's Gmail (brandon@stonepropertysolutions.com, Google Workspace — its MX is NEVER touched) auto-forwards to `<anything>@in.spsway.app`; Resend Inbound (GA, all plans; MX on the subdomain from the Resend dashboard → Domains) receives it and fires `email.received` at `https://spsway.app/api/inbound-email?key=<this secret>`. The webhook payload is metadata-only — the endpoint fetches the full body via `GET api.resend.com/emails/receiving/{id}` with `RESEND_API_KEY`, has Claude triage it (lead|bill|client|other; existing-client match by from_email wins over AI; AI down → "other"), stores to `sps_inbox` (SQL below), pushes the owner (new_lead / bill_received toggles), and the APP imports AI-leads into sps_leads two-phase (server never writes sps_leads — single-writer rule). Owner reads mail ONLY via `api/inbox.js` (requireOwner; sps_inbox has NO client-readable policy — private mail). Resend retains mail ~30 days; sps_inbox is the system of record.

Optional: `SUPABASE_URL`, `RESEND_FROM`, `PUBLIC_APP_URL`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `ANTHROPIC_MODEL`.

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
-- QuickBooks OAuth tokens — ONE row (id='default'), upserted by api/quickbooks/* with the SERVICE_ROLE
-- key. saveTokens posts with ?on_conflict=id, so `id` MUST be the primary key / unique. If this table
-- is missing or `id` isn't unique, the OAuth callback "connects" in the browser but the token never
-- persists → /status reads "not connected" / "Load failed" forever. (This was undocumented and is a
-- known cause of that exact bug — create it before connecting QuickBooks.)
CREATE TABLE IF NOT EXISTS public.qb_tokens (
  id            text PRIMARY KEY,
  realm_id      text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz DEFAULT now()
);
ALTER TABLE public.qb_tokens ENABLE ROW LEVEL SECURITY;
-- No policies needed: only the server's SERVICE_ROLE key touches it (bypasses RLS); the anon key gets nothing.

-- Plaid (bank sync) token — same posture and SAME TRAP as qb_tokens above: ONE row (id='default'),
-- upserted by api/plaid/exchange.js with the SERVICE_ROLE key via ?on_conflict=id, so `id` MUST be
-- the primary key. If this table is missing, Plaid Link "connects" in the popup but the token never
-- persists → status reads "not connected" forever (exchange.js surfaces a "create the plaid_tokens
-- table" error since 2026-07). Feature env vars: PLAID_CLIENT_ID + PLAID_SECRET + PLAID_ENV
-- (sandbox|production); ships dark until set. The /api/plaid data endpoints are OWNER-ONLY via
-- requireOwner in api/plaid/_plaid.js (owner email from sps_team/sps_branding/sps_email, verified
-- INDEPENDENTLY of API_AUTH_ENFORCED — bank data must never be readable by a signed-in staff tech).
CREATE TABLE IF NOT EXISTS public.plaid_tokens (
  id           text PRIMARY KEY,
  access_token text,
  item_id      text,
  institution  text,
  updated_at   timestamptz DEFAULT now()
);
ALTER TABLE public.plaid_tokens ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only, same as qb_tokens.

-- Owner-side audit log of automated outbound texts (on-my-way, invoice, reminder, …). Kept OUT of the
-- client conversation (sps_messages) so the chat stays clean — surfaced as a collapsed "Sent texts"
-- strip in each client's chat. Append-only; the app reads the latest ~80 per client. Best-effort:
-- sendSms() logs here via logComm() but never blocks/fails a send, and the feature no-ops until this
-- table exists. (sps_messages has a CHECK(sender in ('staff','client')), so the log can't live there.)
CREATE TABLE IF NOT EXISTS public.sps_comms_log (
  id          bigserial PRIMARY KEY,
  client_id   text NOT NULL,
  type        text NOT NULL DEFAULT 'Text',
  channel     text NOT NULL DEFAULT 'sms',
  body        text NOT NULL DEFAULT '',
  ok          boolean DEFAULT true,
  origin      text NOT NULL DEFAULT '',  -- WHO/WHAT triggered the send (Comms → Log). Existing installs: ALTER TABLE ... ADD COLUMN IF NOT EXISTS (run 2026-07-03)
  recipient   text NOT NULL DEFAULT '',  -- where it went; owner-directed rows store "you" (NEVER the owner's personal phone/email — table is broadly readable until the RLS lockdown)
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sps_comms_log_client_idx ON public.sps_comms_log(client_id, created_at DESC);
ALTER TABLE public.sps_comms_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "comms_log read"   ON public.sps_comms_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "comms_log insert" ON public.sps_comms_log FOR INSERT TO authenticated WITH CHECK (true);

-- Native push device tokens (Build 27) — one row per DEVICE, upserted by api/push/register.js
-- with the SERVICE_ROLE key (?on_conflict=token, so `token` MUST be the primary key — same trap
-- as qb_tokens/plaid_tokens above; without this table, "Enable on this device" errors with a
-- "create the sps_push_tokens table" hint). role/user_key are derived SERVER-side from the
-- caller's VERIFIED auth email (never from body claims): sps_team member → owner|staff (+ member
-- id), else owner-email chain → owner, else sps_clients match → client (+ client id). Dead tokens
-- (APNs 410 Unregistered / BadDeviceToken) are pruned automatically on send by api/_push.js.
CREATE TABLE IF NOT EXISTS public.sps_push_tokens (
  token       text PRIMARY KEY,
  user_email  text NOT NULL DEFAULT '',
  user_key    text NOT NULL DEFAULT '',
  role        text NOT NULL DEFAULT 'staff',
  platform    text NOT NULL DEFAULT 'ios',
  enabled     boolean DEFAULT true,
  updated_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sps_push_tokens_role_idx ON public.sps_push_tokens(role);
CREATE INDEX IF NOT EXISTS sps_push_tokens_user_idx ON public.sps_push_tokens(role, user_key);
ALTER TABLE public.sps_push_tokens ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only, same posture as qb_tokens/plaid_tokens.

-- Work-email inbox (Comms → Email) — one row per received email, upserted by api/inbound-email.js
-- with the SERVICE_ROLE key (?on_conflict=id = the Resend email id, so webhook retries collapse).
-- NO RLS POLICIES AT ALL — this is the OWNER'S PRIVATE MAIL; the app reads it exclusively through
-- the owner-gated api/inbox.js (requireOwner), never the shared supabase client.
CREATE TABLE IF NOT EXISTS public.sps_inbox (
  id          text PRIMARY KEY,           -- Resend received-email id
  from_name   text NOT NULL DEFAULT '',
  from_email  text NOT NULL DEFAULT '',
  subject     text NOT NULL DEFAULT '',
  body_text   text NOT NULL DEFAULT '',   -- plain text (or stripped HTML), capped at 20k — the AI/preview/search form
  body_html   text NOT NULL DEFAULT '',   -- real HTML (scripts stripped, 300k cap) — rendered in a sandboxed iframe so emails look like Gmail. Existing installs: ALTER TABLE ... ADD COLUMN IF NOT EXISTS
  message_id  text NOT NULL DEFAULT '',   -- RFC Message-ID for threading in-app replies (In-Reply-To)
  kind        text NOT NULL DEFAULT 'other',  -- lead | bill | client | other (AI triage; owner can reclassify)
  ai          jsonb,                      -- {kind, confidence, summary, lead:{...}, bill:{...}} or {clientId,...}
  lead_id     text NOT NULL DEFAULT '',   -- stamped when the app confirms the lead in sps_leads (two-phase ack)
  read        boolean DEFAULT false,
  replied     boolean DEFAULT false,      -- an in-app reply went out (api/inbox action:"reply")
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sps_inbox_kind_idx ON public.sps_inbox(kind, lead_id);
ALTER TABLE public.sps_inbox ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service-role only.

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

-- Public NO-LOGIN live-tracking page (/?track=<token>, the LiveTrack component) reads as the ANON
-- client. Without these two policies it gets NULL on everything → every link shows "Tracking link
-- unavailable" and the moving dot never appears. Expose ONLY the minimum (added 2026-06-29):
--   1) per-link records keyed sps_track_<unguessable token> in app_state — a client can read its own
--      stop ONLY (it can't list keys or reach sps_clients / sps_invoices / sps_schedule), and
--   2) actively-broadcasting tech locations (NOT the whole table).
-- The staff side writes the sps_track_<token> record in App.jsx ensureTrackToken() on Head Here / I'm
-- Here, with status scheduled→enroute→arrived. NOTE #2 makes an on-the-clock tech's live GPS readable
-- by anyone holding the (public) anon key — inherent to no-login tracking; limited to is_active rows.
CREATE POLICY "anon read tracking tokens"
  ON public.app_state FOR SELECT TO anon USING (key LIKE 'sps_track_%');
CREATE POLICY "anon read active staff locations"
  ON public.staff_locations FOR SELECT TO anon USING (is_active = true);
```

## Message-push webhook (run once in the APP's Supabase project — Build 27)

Chat messages never pass through `api/` (both sides insert into `sps_messages` directly), so
pushes for them ride a Database Webhook. One-time setup, same recipe as the website's lead
webhook: **Database → Webhooks → Enable webhooks** first (creates the `supabase_functions`
schema — skipping this gives `3F000 schema supabase_functions does not exist`), then run
(replace `<SECRET>` with the `MSG_WEBHOOK_SECRET` value set in Vercel):

```sql
create trigger sps_messages_push_webhook
  after insert on public.sps_messages
  for each row
  execute function supabase_functions.http_request(
    'https://spsway.app/api/message-intake',
    'POST',
    '{"Content-Type":"application/json","Authorization":"Bearer <SECRET>"}',
    '{}',
    '5000'
  );
```

Until this trigger exists, everything else works — message pushes are simply absent. The
endpoint always answers 200 once authorized (Supabase retries non-2xx → would double-push).

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
