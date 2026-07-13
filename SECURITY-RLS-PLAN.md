# SPS Way RLS lockdown

The deployable migration is [`SECURITY-RLS-MIGRATION.sql`](./SECURITY-RLS-MIGRATION.sql). It is
idempotent and intentionally has not been run against production by this repository change.

## What it closes

- `app_state` is readable/writable only by verified members of `sps_team` (or a trusted,
  server-managed `app_metadata` staff claim). Portal clients can no longer download or overwrite
  the shared clients, invoices, schedule, costs, team, or profit blobs.
- `sps_team` stays readable to verified staff but only an owner can insert/update it. A new value
  must retain an active owner with a nonempty email, and the row cannot be deleted through the app.
- Security/admin configuration (`sps_email`, `sps_branding`, `sps_roles`, budget/cost settings,
  invoicing settings, and automation schedule settings) is owner-writable. This prevents a
  non-owner from redirecting owner alerts or changing company-wide sending/payment controls.
- `sps_messages` becomes staff-only for direct Supabase access. Client reads/writes must use a
  scoped server route with the service-role key.
- `sps_comms_log` becomes staff-readable and staff-append-only.
- `app_state_backups` and `sps_backups` are created/upgraded when needed and become owner-only.
  These tables contain full state/client recovery copies and must never inherit a broad
  authenticated policy.
- `staff_locations` writes are bound to both `auth.uid()` and the matching team member id. A
  legacy row whose `auth_uid` is null can be claimed once by that matching staff member.
- Members with `active: false`, `disabled: true`, or status `disabled`, `inactive`, or `revoked`
  fail closed for both role and location identity checks. Duplicate active roster emails also fail
  closed, and neither case can fall through to an old trusted claim in the JWT.
- All anonymous tracking policies are removed. Service-only token/inbox tables have any stray
  anon/authenticated policies removed as well.
- If `public.leads` exists in this Supabase project, its policies are replaced with one anonymous
  INSERT-only intake policy. Anonymous callers cannot read/update/delete leads; the service role
  keeps the access used by the webhook/backfill bridge.

The role helpers are `SECURITY DEFINER`, owned by `postgres`, have a fixed `pg_catalog`
`search_path`, and fail closed. They parse both forms already used by `app_state.value`:

- a real JSON array; and
- a JSON string containing that array (including a few layers of legacy double encoding).

## Pre-deploy checklist

1. Back up `app_state`, `app_state_backups`, `sps_backups`, `sps_messages`, `staff_locations`,
   `sps_comms_log`, and `leads` when present. Export the current table grants and RLS policies too.
2. Confirm `sps_team` parses and contains the production owner email:

   ```sql
   select key, value, jsonb_typeof(value)
   from public.app_state
   where key = 'sps_team';
   ```

   After loading the migration functions in a staging project, also run:

   ```sql
   select public.sps_rls_normalize_team(value)
   from public.app_state
   where key = 'sps_team';
   ```

3. Confirm that email belongs to a confirmed user in Supabase Authentication.
4. On an existing production project, run `APP-STATE-CONCURRENCY-MIGRATION.sql` first. This
   phase-zero migration adds database-owned row versions and CAS RPCs but changes no table policy
   or grant, so version 1.1 can keep working while the compatible client rolls out.
5. Deploy and verify `api/portal-data.js`, `api/portal-action.js`, `api/portal-messages.js`, and
   `api/live-track.js` with the service-role key.
   The response must use explicit field allowlists. Returning the stored client object or invoice/
   history objects wholesale can expose internal notes, cost breakdowns, private documents, or
   future fields even though RLS is fixed.
6. Confirm the deployed app version writes both `staff_id` and `auth_uid` to
   `staff_locations` (the current `App.jsx` does).
7. Plan a maintenance window. Policy replacement is transactional, but existing sessions should
   be refreshed/reopened after rollout.

For a brand-new project, seed `sps_team` through SQL Editor/service-role with an owner email that
matches the first confirmed Auth user. A trusted bootstrap claim may instead be assigned with the
Admin API:

```json
{
  "sps_role": "owner",
  "sps_staff_id": "e1"
}
```

Put those fields in `app_metadata`, never `user_metadata`, and remove them after bootstrap. Claims
are considered only while `sps_team` is missing or empty. Once a non-empty roster exists it is the
authoritative source: removed, duplicate, inactive, disabled, and revoked members all fail closed.

## Deployment

For an existing production project, run/deploy in this order:

```text
APP-STATE-CONCURRENCY-MIGRATION.sql
deploy the version-aware client + scoped portal APIs
SECURITY-RLS-MIGRATION.sql
MEDIA-STORAGE-SECURITY-MIGRATION.sql (only after compatible native clients are adopted)
APP-STATE-CONCURRENCY-ENFORCE.sql (only after every legacy writer is retired)
```

Do not copy individual policy statements out of the migrations. The security transaction first creates the parsing
helpers, drops every legacy/custom policy on the protected tables, recreates the intended policies,
and aborts if an anonymous/public policy survives.

## Expected application impact

- Verified staff whose login email matches `sps_team` keep direct app-state, message, comm-log, and
  staff-location access.
- Non-owner staff can no longer alter `sps_team`. The UI's client-side permission checks are no
  longer the only control.
- Portal data and chat require the scoped portal endpoints. Any remaining direct client-side
  `app_state`/`sps_messages` fallback will be denied safely by the database.
- Public `/?track=<token>` links require `api/live-track.js`, which must validate token expiry and
  stop status and return only the minimum location fields. Direct anonymous/client reads of
  `app_state` and `staff_locations` are deliberately revoked; do not restore the old anon policies.
- The current “Reset all data” flow attempts to delete/reseed `sps_team` with a blank owner email;
  the database now blocks that unsafe part of the reset. Other state keys remain staff-writable.
- Existing location rows with `auth_uid is null` are claimed on the matching staff member's next
  successful upsert. Rows with an incorrect non-null `auth_uid` require a one-time SQL correction.

## Verification

Run after deployment as an owner, a non-owner staff user, a portal client, and anon:

1. Owner: read/write a normal state key and update `sps_team` while retaining an owner.
2. Staff: read state/messages, write a normal state key, and verify `sps_team` update is denied.
3. Client: verify direct `app_state`, `app_state_backups`, `sps_backups`, `sps_messages`,
   `sps_comms_log`, and `staff_locations` queries
   return no rows/permission errors, while `api/portal-data` returns only that client's slice.
4. Anon: verify both tracking-token and active-location direct queries are denied.
5. Location: verify a staff user can upsert only their own `staff_id` with their own `auth_uid`.
6. Inspect installed policies:

   ```sql
   select tablename, policyname, roles, cmd, qual, with_check
   from pg_catalog.pg_policies
   where schemaname = 'public'
     and tablename in (
       'app_state', 'app_state_backups', 'sps_backups', 'sps_messages',
       'staff_locations', 'sps_comms_log', 'leads'
     )
   order by tablename, policyname;
   ```
7. If `leads` exists, submit one test lead anonymously and confirm anonymous SELECT/UPDATE/DELETE
   are denied. The form must use a minimal INSERT response; lead rows are never returned to anon.

Rollback should restore from the backup and a reviewed prior policy set. Do not roll back to
`USING (true)` for `authenticated`; client and staff accounts share that database role.
