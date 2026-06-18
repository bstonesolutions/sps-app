# Security / RLS remediation plan

From the full-app diagnostic. This is the **#1 critical finding** and lives in the storage layer —
your hard-ruled domain (CLAUDE.md rule #1) — so nothing here has been applied. This is a plan for
your review + approval. None of it touches `supabaseClient.js`.

---

## The problem (one root cause behind 5 findings)

Clients and staff sign into the **same** Supabase project as the `authenticated` role, and the app
loads **one shared `app_state` table** (key/value: `sps_clients`, `sps_invoices`, `sps_team`,
costs, profit, …) whose RLS is `using (true)`. So:

- **Any logged-in client can read EVERY client's data** — all PII, every invoice, the team roster,
  and profit — by querying `app_state` directly (bypassing the React "client vs staff" UI gate,
  which is **cosmetic, not a security boundary**). *(CRITICAL)*
- **`sps_messages`** (`using(true)`) lets any client read **all** cross-client chat and forge
  messages as staff. *(HIGH)*
- **`staff_locations`** write policy `using(true)` lets anyone spoof a tech's GPS / `is_active`. *(MED)*

**Until this is closed, the portal is not safe to expose to real external client logins.** The
interim mitigation is simple: don't issue client magic links / keep client accounts out of this
project until the fix below lands.

---

## Why this is more than a one-line SQL change

The naive fix — "make `app_state` SELECT staff-only" — **breaks the client portal**, because the
portal currently reads its own invoices/schedule from that same shared `app_state` cache. And
splitting by key doesn't help either: a single key like `sps_invoices` holds *every* client's
invoices in one JSON blob, so any client who can read that key still sees everyone.

Real fix = **clients must stop reading `app_state` directly and instead get only their own slice.**

---

## Recommended approach: server-mediated client portal (robust)

Give the client portal its data through a serverless endpoint that runs with the service-role key
and returns **only the authenticated caller's slice** — then lock `app_state` down to staff.

1. **New endpoint** `api/portal-data.js`:
   - Require the caller's Supabase access token (`Authorization: Bearer …`); resolve their identity
     via `GET {SUPABASE_URL}/auth/v1/user`.
   - With the service-role key, read `app_state`, and return ONLY: that client's own record, their
     invoices, their schedule stops, and branding. Never the team roster, costs, profit, or other
     clients.
2. **Client portal reads from `api/portal-data`** instead of the shared `app_state` cache. (This is
   an app change in the portal data flow; it does not require editing `supabaseClient.js` — the
   portal can fetch its own scoped payload.)
3. **Lock `app_state` to staff only.** Tag staff accounts with a trusted server-set claim (set
   `app_metadata.role='staff'` via the admin API at invite time — NOT self-asserted), then:

```sql
-- Staff-only read/write of the shared business store. Clients get nothing here.
drop policy if exists "app_state read"   on app_state;
drop policy if exists "app_state write"  on app_state;
create policy "app_state read (staff)"  on app_state for select to authenticated
  using ( (auth.jwt() -> 'app_metadata' ->> 'role') = 'staff' );
create policy "app_state write (staff)" on app_state for all to authenticated
  using      ( (auth.jwt() -> 'app_metadata' ->> 'role') = 'staff' )
  with check ( (auth.jwt() -> 'app_metadata' ->> 'role') = 'staff' );
```

### `sps_messages` (same model)
Route portal chat reads/writes through a serverless function (service-role key) that enforces a
client may only touch their own `client_id` and pins `sender` to the verified role; keep the table
RLS denying direct `authenticated` access. (A pure-RLS alternative works only if `client_id` is
made equal to the client's auth email so a policy can compare `auth.jwt()->>'email' = client_id`.)

---

## Runnable now (lower-risk, independent)

### staff_locations — stop GPS spoofing
Bind writes to the writer's own auth identity. Requires adding `auth_uid` to the upsert (a small,
explicit storage-layer change for you to approve — `App.jsx` would include
`auth_uid: (await supabase.auth.getUser()).data.user.id` in the `staff_locations` upsert):

```sql
alter table public.staff_locations add column if not exists auth_uid uuid;
drop policy if exists "staff_locations insert (authenticated)" on public.staff_locations;
drop policy if exists "staff_locations update (authenticated)" on public.staff_locations;
create policy "staff_locations insert (own)" on public.staff_locations
  for insert to authenticated with check (auth_uid = auth.uid());
create policy "staff_locations update (own)" on public.staff_locations
  for update to authenticated using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());
-- SELECT can stay open to authenticated; the public LiveTrack page reads only lat/lng.
```

---

## Suggested order

1. **Now:** don't issue client portal logins yet (interim mitigation). Apply the `staff_locations`
   write fix.
2. **Next:** build `api/portal-data.js` + repoint the portal + lock `app_state` to staff. Test
   thoroughly that staff still read/write everything and a client session reads only its own slice.
3. **Then:** apply the same server-mediated pattern to `sps_messages`.

I can build the serverless endpoints + the portal repoint (that's app code, not the storage layer)
whenever you're ready — say the word and I'll start with `api/portal-data.js`.
