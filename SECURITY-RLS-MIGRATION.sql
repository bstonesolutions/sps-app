-- ============================================================================
-- SPS Way — production RLS lockdown
-- ============================================================================
-- Run once in the APP Supabase project's SQL Editor as the project owner.
-- Safe to run again: tables/columns/functions are created idempotently, every
-- policy on the protected tables is dropped, and the intended policies are
-- recreated from scratch.
-- The migration preserves the authenticated role's app_state DML state from
-- transaction start. Existing additive rollouts remain writable, while fresh
-- or already-enforced installs remain CAS-only after a rerun.
--
-- IMPORTANT BEFORE RUNNING
--   1. Confirm public.app_state contains an sps_team row with at least one owner
--      whose email exactly matches a confirmed Supabase Auth user's email.
--   2. Deploy reviewed, field-allowlisted portal-data, portal-action,
--      portal-messages, and live-track endpoints first.
--      Portal clients are intentionally denied direct app_state and sps_messages
--      access after this. Do not expose raw client/history/invoice objects.
--   3. Anonymous live tracking is intentionally revoked. /?track= links require
--      a scoped server endpoint before they can work again.
--   4. The currently shipped app already writes auth_uid on staff_locations.
--   5. For a no-downtime existing-app rollout, first run
--      APP-STATE-CONCURRENCY-MIGRATION.sql and deploy the version-aware clients.
--      That phase-zero migration changes no policies or table grants. This file
--      also installs/reconciles the same versioning and CAS RPCs, preserves the
--      current direct-write grant state, and then performs the RLS lockdown.
--      After every legacy writer is retired, run APP-STATE-CONCURRENCY-ENFORCE.sql.
--
-- Trusted bootstrap alternative for a brand-new install with no team roster:
-- set app_metadata.sps_role='owner' and app_metadata.sps_staff_id='<team id>'
-- with the Supabase Admin API, then insert a valid sps_team value. Never put
-- these claims in user_metadata; users can edit user_metadata themselves.
-- ============================================================================

begin;

-- Capture effective authenticated app_state DML before this migration creates
-- or changes anything. Transaction-local settings survive until the grant
-- section and disappear at commit. If the table does not exist yet, a fresh
-- install starts closed and uses only the CAS RPCs.
do $capture_app_state_grants$
declare
  app_state_oid pg_catalog.oid := pg_catalog.to_regclass('public.app_state');
  had_insert boolean := false;
  had_update boolean := false;
  had_delete boolean := false;
begin
  if app_state_oid is not null then
    had_insert := coalesce(pg_catalog.has_table_privilege(
      'authenticated', app_state_oid, 'INSERT'
    ), false);
    had_update := coalesce(pg_catalog.has_table_privilege(
      'authenticated', app_state_oid, 'UPDATE'
    ), false);
    had_delete := coalesce(pg_catalog.has_table_privilege(
      'authenticated', app_state_oid, 'DELETE'
    ), false);
  end if;

  perform pg_catalog.set_config(
    'sps_security.app_state_authenticated_insert', had_insert::text, true
  );
  perform pg_catalog.set_config(
    'sps_security.app_state_authenticated_update', had_update::text, true
  );
  perform pg_catalog.set_config(
    'sps_security.app_state_authenticated_delete', had_delete::text, true
  );
end;
$capture_app_state_grants$;

-- --------------------------------------------------------------------------
-- Core tables. CREATE/ADD IF NOT EXISTS keeps this deployable on older installs.
-- --------------------------------------------------------------------------

create table if not exists public.app_state (
  key        text primary key,
  value      jsonb,
  version    bigint not null default 1,
  updated_at timestamptz default now()
);

alter table public.app_state
  add column if not exists version bigint;

-- A rerun may encounter the version trigger created by the concurrency rollout.
-- Drop it before repairing legacy/null values, then recreate it below.
drop trigger if exists app_state_set_version on public.app_state;

update public.app_state
set version = 1
where version is null or version < 1;

alter table public.app_state
  alter column version set default 1,
  alter column version set not null;

do $version_constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.app_state'::pg_catalog.regclass
      and conname = 'app_state_version_positive'
  ) then
    alter table public.app_state
      add constraint app_state_version_positive check (version > 0);
  end if;
end;
$version_constraint$;

create table if not exists public.sps_messages (
  id          bigserial primary key,
  client_id   text not null,
  sender      text not null check (sender in ('staff', 'client')),
  sender_name text not null default '',
  body        text not null,
  created_at  timestamptz default now(),
  read_at     timestamptz
);
create index if not exists sps_messages_client_idx
  on public.sps_messages(client_id, created_at desc);

create table if not exists public.staff_locations (
  staff_id   text primary key,
  lat        double precision,
  lng        double precision,
  updated_at timestamptz default now(),
  is_active  boolean default false,
  auth_uid   uuid
);
alter table public.staff_locations
  add column if not exists auth_uid uuid;

create table if not exists public.sps_comms_log (
  id         bigserial primary key,
  client_id  text not null,
  type       text not null default 'Text',
  channel    text not null default 'sms',
  body       text not null default '',
  ok         boolean default true,
  origin     text not null default '',
  recipient  text not null default '',
  created_at timestamptz default now()
);
alter table public.sps_comms_log
  add column if not exists origin text not null default '';
alter table public.sps_comms_log
  add column if not exists recipient text not null default '';
create index if not exists sps_comms_log_client_idx
  on public.sps_comms_log(client_id, created_at desc);

-- Owner-managed safety copies contain the same sensitive material as app_state.
-- Older production projects created these tables manually, so define the expected
-- schema for missing installs and add non-key columns that an older table may lack.
create table if not exists public.app_state_backups (
  id         bigserial primary key,
  label      text not null default 'Auto',
  snapshot   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.app_state_backups
  add column if not exists id bigserial;
alter table public.app_state_backups
  add column if not exists label text not null default 'Auto';
alter table public.app_state_backups
  add column if not exists snapshot jsonb not null default '{}'::jsonb;
alter table public.app_state_backups
  add column if not exists created_at timestamptz not null default now();

create table if not exists public.sps_backups (
  key        text primary key,
  value      jsonb,
  created_at timestamptz not null default now()
);
alter table public.sps_backups
  add column if not exists key text;
alter table public.sps_backups
  add column if not exists value jsonb;
alter table public.sps_backups
  add column if not exists created_at timestamptz not null default now();

alter table public.app_state enable row level security;
alter table public.sps_messages enable row level security;
alter table public.staff_locations enable row level security;
alter table public.sps_comms_log enable row level security;
alter table public.app_state_backups enable row level security;
alter table public.sps_backups enable row level security;

-- The version is database-owned. This also makes legacy direct writes and
-- service-role writers advance the version during the additive rollout.
create or replace function public.sps_app_state_set_version()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  else
    if old.version = 9223372036854775807 then
      raise exception 'app_state version exhausted' using errcode = '22003';
    end if;
    new.version := old.version + 1;
  end if;

  new.updated_at := pg_catalog.statement_timestamp();
  return new;
end;
$function$;

alter function public.sps_app_state_set_version() owner to postgres;
revoke all on function public.sps_app_state_set_version()
  from public, anon, authenticated;

create trigger app_state_set_version
before insert or update on public.app_state
for each row execute function public.sps_app_state_set_version();

-- --------------------------------------------------------------------------
-- SECURITY DEFINER role helpers.
--
-- app_state.value is jsonb, but the current client stores JSON.stringify(...),
-- so sps_team can be either a real JSON array or a JSON string containing an
-- array (occasionally more than once encoded on legacy backups). The normalizer
-- unwraps up to four string layers and fails closed to [].
--
-- Functions are owned by postgres, use a fixed search_path, and expose only
-- boolean/staff-id policy entry points. The current-team reader, normalizer, and
-- role resolver are not directly executable by anon/authenticated. Nested calls
-- run as the postgres function owner, which retains EXECUTE after the revokes.
-- --------------------------------------------------------------------------

create or replace function public.sps_rls_normalize_team(raw_value jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $function$
declare
  parsed jsonb := raw_value;
  depth integer := 0;
begin
  while parsed is not null
    and pg_catalog.jsonb_typeof(parsed) = 'string'
    and depth < 4
  loop
    begin
      parsed := (parsed #>> '{}')::jsonb;
    exception when others then
      return '[]'::jsonb;
    end;
    depth := depth + 1;
  end loop;

  if pg_catalog.jsonb_typeof(parsed) = 'array' then
    return parsed;
  end if;
  return '[]'::jsonb;
end;
$function$;

create or replace function public.sps_rls_current_team()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
set row_security = off
as $function$
  select public.sps_rls_normalize_team(
    (select a.value from public.app_state as a where a.key = 'sps_team' limit 1)
  );
$function$;

create or replace function public.sps_rls_role()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
set row_security = off
as $function$
declare
  token jsonb := auth.jwt();
  team jsonb;
  verified_email text;
  team_role text;
  claim_role text;
begin
  if auth.uid() is null then
    return null;
  end if;

  verified_email := pg_catalog.lower(pg_catalog.btrim(coalesce(token ->> 'email', '')));
  team := public.sps_rls_current_team();
  if pg_catalog.jsonb_array_length(team) > 0 then
    select case
      when count(*) <> 1 then null
      when pg_catalog.bool_or(
        pg_catalog.lower(pg_catalog.btrim(coalesce(member ->> 'role', 'staff'))) = 'owner'
      ) then 'owner'
      else 'staff'
    end
    into team_role
    from pg_catalog.jsonb_array_elements(team) as member
    where pg_catalog.lower(pg_catalog.btrim(coalesce(member ->> 'email', ''))) = verified_email
      and pg_catalog.lower(coalesce(member ->> 'active', 'true')) <> 'false'
      and pg_catalog.lower(coalesce(member ->> 'disabled', 'false')) <> 'true'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(member ->> 'status', '')))
        not in ('disabled', 'inactive', 'revoked');

    -- A non-empty roster is always authoritative. A missing, duplicate,
    -- inactive, disabled, or revoked match fails closed and cannot fall through
    -- to a stale app_metadata claim.
    return team_role;
  end if;

  -- Trusted, server-managed fallback for secure bootstrap only. This branch is
  -- unreachable after a non-empty normalized team roster exists.
  claim_role := pg_catalog.lower(coalesce(
    token -> 'app_metadata' ->> 'sps_role',
    token -> 'app_metadata' ->> 'role',
    ''
  ));
  if claim_role in ('owner', 'staff') then
    return claim_role;
  end if;
  return null;
end;
$function$;

create or replace function public.sps_rls_is_staff()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
set row_security = off
as $function$
  select coalesce(public.sps_rls_role() in ('owner', 'staff'), false);
$function$;

create or replace function public.sps_rls_is_owner()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
set row_security = off
as $function$
  select coalesce(public.sps_rls_role() = 'owner', false);
$function$;

create or replace function public.sps_rls_staff_id()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
set row_security = off
as $function$
declare
  token jsonb := auth.jwt();
  team jsonb;
  verified_email text;
  matched_count integer;
  matched_id text;
  claim_id text;
begin
  if auth.uid() is null then
    return null;
  end if;

  verified_email := pg_catalog.lower(pg_catalog.btrim(coalesce(token ->> 'email', '')));
  team := public.sps_rls_current_team();
  if pg_catalog.jsonb_array_length(team) > 0 then
    select
      count(*),
      min(nullif(pg_catalog.btrim(coalesce(member ->> 'id', '')), ''))
      into matched_count, matched_id
    from pg_catalog.jsonb_array_elements(team) as member
    where pg_catalog.lower(pg_catalog.btrim(coalesce(member ->> 'email', ''))) = verified_email
      and pg_catalog.lower(coalesce(member ->> 'active', 'true')) <> 'false'
      and pg_catalog.lower(coalesce(member ->> 'disabled', 'false')) <> 'true'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(member ->> 'status', '')))
        not in ('disabled', 'inactive', 'revoked');

    -- A non-empty roster is authoritative. Duplicate matches, a missing id, or
    -- an inactive/disabled member fails closed instead of using a stale claim.
    if matched_count = 1 and matched_id is not null then
      return matched_id;
    end if;
    return null;
  end if;

  claim_id := pg_catalog.btrim(coalesce(
    token -> 'app_metadata' ->> 'sps_staff_id',
    token -> 'app_metadata' ->> 'staff_id',
    ''
  ));
  return nullif(claim_id, '');
end;
$function$;

create or replace function public.sps_rls_team_has_owner(candidate jsonb)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog
as $function$
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(public.sps_rls_normalize_team(candidate)) as member
    where pg_catalog.lower(pg_catalog.btrim(coalesce(member ->> 'role', ''))) = 'owner'
      and pg_catalog.btrim(coalesce(member ->> 'email', '')) <> ''
      and pg_catalog.lower(coalesce(member ->> 'active', 'true')) <> 'false'
      and pg_catalog.lower(coalesce(member ->> 'disabled', 'false')) <> 'true'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(member ->> 'status', '')))
        not in ('disabled', 'inactive', 'revoked')
  );
$function$;

-- Centralized app_state authorization is shared by the direct-write RLS policy
-- used during rollout and the CAS SECURITY DEFINER functions. Keep this key list
-- synchronized here rather than duplicating it across policy and RPC bodies.
create or replace function public.sps_rls_app_state_target_allowed(p_key text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
set row_security = off
as $function$
  select coalesce(
    public.sps_rls_is_staff()
    and (
      p_key not in (
        'sps_team', 'sps_email', 'sps_branding', 'sps_roles',
        'sps_budget', 'sps_costs', 'sps_invoicing', 'sps_schedule_cfg'
      )
      or public.sps_rls_is_owner()
    ),
    false
  );
$function$;

create or replace function public.sps_rls_app_state_write_allowed(
  p_key text,
  p_value jsonb
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
set row_security = off
as $function$
  select coalesce(
    public.sps_rls_app_state_target_allowed(p_key)
    and (
      p_key <> 'sps_team'
      or public.sps_rls_team_has_owner(p_value)
    ),
    false
  );
$function$;

-- Atomic app_state insert/update compare-and-swap. Expected version zero means
-- insert-only; a positive expected version means update exactly that version.
-- The function returns metadata only so conflict values are still read through
-- the normal staff SELECT RLS policy.
create or replace function public.sps_app_state_cas(
  p_key text,
  p_expected_version bigint,
  p_value jsonb
)
returns table (
  applied boolean,
  outcome text,
  current_version bigint,
  changed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
set row_security = off
as $function$
declare
  state_row public.app_state%rowtype;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if p_key is null or pg_catalog.btrim(p_key) = '' then
    raise exception 'A non-empty app_state key is required' using errcode = '22023';
  end if;

  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'Expected version must be zero or greater' using errcode = '22023';
  end if;

  if not caller_is_service then
    if auth.uid() is null
      or not public.sps_rls_app_state_write_allowed(p_key, p_value)
    then
      raise exception 'Not authorized to write this app_state key'
        using errcode = '42501';
    end if;
  elsif p_key = 'sps_team'
    and not public.sps_rls_team_has_owner(p_value)
  then
    raise exception 'sps_team must retain an active owner'
      using errcode = '23514';
  end if;

  if p_expected_version = 0 then
    insert into public.app_state (key, value)
    values (p_key, p_value)
    on conflict (key) do nothing
    returning * into state_row;

    if found then
      applied := true;
      outcome := 'inserted';
      current_version := state_row.version;
      changed_at := state_row.updated_at;
      return next;
      return;
    end if;
  else
    update public.app_state
    set value = p_value
    where key = p_key
      and version = p_expected_version
    returning * into state_row;

    if found then
      applied := true;
      outcome := 'updated';
      current_version := state_row.version;
      changed_at := state_row.updated_at;
      return next;
      return;
    end if;
  end if;

  select *
  into state_row
  from public.app_state
  where key = p_key;

  applied := false;
  if found then
    outcome := 'conflict';
    current_version := state_row.version;
    changed_at := state_row.updated_at;
  else
    outcome := 'missing';
    current_version := null;
    changed_at := null;
  end if;
  return next;
end;
$function$;

-- Version-checked delete. The team roster remains undeletable for staff and
-- service-role callers alike.
create or replace function public.sps_app_state_delete_cas(
  p_key text,
  p_expected_version bigint
)
returns table (
  applied boolean,
  outcome text,
  current_version bigint,
  changed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
set row_security = off
as $function$
declare
  state_row public.app_state%rowtype;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if p_key is null or pg_catalog.btrim(p_key) = '' then
    raise exception 'A non-empty app_state key is required' using errcode = '22023';
  end if;

  if p_expected_version is null or p_expected_version <= 0 then
    raise exception 'Delete expected version must be greater than zero'
      using errcode = '22023';
  end if;

  if p_key = 'sps_team' then
    raise exception 'sps_team cannot be deleted' using errcode = '42501';
  end if;

  if not caller_is_service then
    if auth.uid() is null
      or not public.sps_rls_app_state_target_allowed(p_key)
    then
      raise exception 'Not authorized to delete this app_state key'
        using errcode = '42501';
    end if;
  end if;

  delete from public.app_state
  where key = p_key
    and version = p_expected_version
  returning * into state_row;

  if found then
    applied := true;
    outcome := 'deleted';
    current_version := state_row.version;
    changed_at := pg_catalog.statement_timestamp();
    return next;
    return;
  end if;

  select *
  into state_row
  from public.app_state
  where key = p_key;

  applied := false;
  if found then
    outcome := 'conflict';
    current_version := state_row.version;
    changed_at := state_row.updated_at;
  else
    outcome := 'missing';
    current_version := null;
    changed_at := null;
  end if;
  return next;
end;
$function$;

-- Owner-only atomic replacement of several app_state rows. This is intended for
-- cross-key business operations and destructive restore/reset workflows that
-- must never leave a half-applied state. Every candidate and expected version is
-- validated before the first write. A late concurrent insert/update raises a
-- private exception inside a PL/pgSQL subtransaction, rolling back every earlier
-- operation before the function returns a conflict result.
create or replace function public.sps_app_state_batch_cas(p_operations jsonb)
returns table (
  applied boolean,
  outcome text,
  conflict_key text,
  current_versions jsonb
)
language plpgsql
security definer
set search_path = pg_catalog
set row_security = off
as $function$
declare
  operation jsonb;
  operation_count integer;
  unique_key_count integer;
  operation_key text;
  active_key text;
  expected_text text;
  expected_version bigint;
  actual_version bigint;
  affected_rows bigint;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if p_operations is null
    or pg_catalog.jsonb_typeof(p_operations) <> 'array'
    or pg_catalog.jsonb_array_length(p_operations) = 0
  then
    raise exception 'Batch operations must be a non-empty JSON array'
      using errcode = '22023';
  end if;

  operation_count := pg_catalog.jsonb_array_length(p_operations);
  if operation_count > 256 then
    raise exception 'Batch operations may contain at most 256 keys'
      using errcode = '22023';
  end if;

  if not caller_is_service then
    if auth.uid() is null or not public.sps_rls_is_owner() then
      raise exception 'Only an owner may replace multiple app_state keys'
        using errcode = '42501';
    end if;
  end if;

  -- Validate the complete request and every candidate authorization invariant
  -- before checking versions or attempting any mutation.
  for operation in
    select item
    from pg_catalog.jsonb_array_elements(p_operations) as items(item)
  loop
    if pg_catalog.jsonb_typeof(operation) <> 'object' then
      raise exception 'Every batch operation must be a JSON object'
        using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(operation -> 'key') <> 'string' then
      raise exception 'Every batch operation requires a string key'
        using errcode = '22023';
    end if;

    operation_key := operation ->> 'key';
    if operation_key is null or pg_catalog.btrim(operation_key) = '' then
      raise exception 'Every batch operation requires a non-empty key'
        using errcode = '22023';
    end if;

    if not (operation ? 'expected_version')
      or pg_catalog.jsonb_typeof(operation -> 'expected_version') <> 'number'
    then
      raise exception 'Every batch operation requires an integer expected_version'
        using errcode = '22023';
    end if;
    expected_text := operation ->> 'expected_version';
    if expected_text !~ '^(0|[1-9][0-9]*)$' then
      raise exception 'Batch expected_version must be a nonnegative integer'
        using errcode = '22023';
    end if;
    begin
      expected_version := expected_text::bigint;
    exception when numeric_value_out_of_range or invalid_text_representation then
      raise exception 'Batch expected_version is outside the bigint range'
        using errcode = '22023';
    end;

    if not (operation ? 'value') then
      raise exception 'Every batch operation requires a value'
        using errcode = '22023';
    end if;

    if caller_is_service then
      if operation_key = 'sps_team'
        and not public.sps_rls_team_has_owner(operation -> 'value')
      then
        raise exception 'sps_team must retain an active owner'
          using errcode = '23514';
      end if;
    elsif not public.sps_rls_app_state_write_allowed(
      operation_key,
      operation -> 'value'
    ) then
      raise exception 'Not authorized to write app_state key %', operation_key
        using errcode = '42501';
    end if;
  end loop;

  select pg_catalog.count(*), pg_catalog.count(distinct item ->> 'key')
  into operation_count, unique_key_count
  from pg_catalog.jsonb_array_elements(p_operations) as items(item);
  if operation_count <> unique_key_count then
    raise exception 'Batch operations may not contain duplicate keys'
      using errcode = '22023';
  end if;

  -- Fast conflict check. The mutation block repeats this atomically, so a writer
  -- racing after this read still cannot cause a partial batch.
  for operation in
    select item
    from pg_catalog.jsonb_array_elements(p_operations) as items(item)
    order by item ->> 'key'
  loop
    operation_key := operation ->> 'key';
    expected_version := (operation ->> 'expected_version')::bigint;
    select state.version
    into actual_version
    from public.app_state as state
    where state.key = operation_key;
    if not found then actual_version := 0; end if;

    if actual_version <> expected_version then
      applied := false;
      outcome := 'conflict';
      conflict_key := operation_key;
      select coalesce(
        pg_catalog.jsonb_object_agg(requested.state_key, coalesce(state.version, 0::bigint)),
        '{}'::jsonb
      )
      into current_versions
      from (
        select item ->> 'key' as state_key
        from pg_catalog.jsonb_array_elements(p_operations) as requested_items(item)
      ) as requested
      left join public.app_state as state on state.key = requested.state_key;
      return next;
      return;
    end if;
  end loop;

  begin
    -- Sorting establishes a consistent row-lock order between competing batches.
    for operation in
      select item
      from pg_catalog.jsonb_array_elements(p_operations) as items(item)
      order by item ->> 'key'
    loop
      operation_key := operation ->> 'key';
      active_key := operation_key;
      expected_version := (operation ->> 'expected_version')::bigint;

      if expected_version = 0 then
        begin
          insert into public.app_state (key, value)
          values (operation_key, operation -> 'value');
        exception when unique_violation then
          raise exception 'batch version conflict' using errcode = 'P0B01';
        end;
      else
        update public.app_state
        set value = operation -> 'value'
        where key = operation_key
          and version = expected_version;
        get diagnostics affected_rows = row_count;
        if affected_rows <> 1 then
          raise exception 'batch version conflict' using errcode = 'P0B01';
        end if;
      end if;
    end loop;
  exception when sqlstate 'P0B01' then
    -- Entering this handler rolls back every statement in the nested block.
    applied := false;
    outcome := 'conflict';
    conflict_key := active_key;
    select coalesce(
      pg_catalog.jsonb_object_agg(requested.state_key, coalesce(state.version, 0::bigint)),
      '{}'::jsonb
    )
    into current_versions
    from (
      select item ->> 'key' as state_key
      from pg_catalog.jsonb_array_elements(p_operations) as requested_items(item)
    ) as requested
    left join public.app_state as state on state.key = requested.state_key;
    return next;
    return;
  end;

  applied := true;
  outcome := 'applied';
  conflict_key := null;
  select coalesce(
    pg_catalog.jsonb_object_agg(requested.state_key, coalesce(state.version, 0::bigint)),
    '{}'::jsonb
  )
  into current_versions
  from (
    select item ->> 'key' as state_key
    from pg_catalog.jsonb_array_elements(p_operations) as requested_items(item)
  ) as requested
  left join public.app_state as state on state.key = requested.state_key;
  return next;
end;
$function$;

alter function public.sps_rls_normalize_team(jsonb) owner to postgres;
alter function public.sps_rls_current_team() owner to postgres;
alter function public.sps_rls_role() owner to postgres;
alter function public.sps_rls_is_staff() owner to postgres;
alter function public.sps_rls_is_owner() owner to postgres;
alter function public.sps_rls_staff_id() owner to postgres;
alter function public.sps_rls_team_has_owner(jsonb) owner to postgres;
alter function public.sps_rls_app_state_target_allowed(text) owner to postgres;
alter function public.sps_rls_app_state_write_allowed(text, jsonb) owner to postgres;
alter function public.sps_app_state_cas(text, bigint, jsonb) owner to postgres;
alter function public.sps_app_state_delete_cas(text, bigint) owner to postgres;
alter function public.sps_app_state_batch_cas(jsonb) owner to postgres;

revoke all on function public.sps_rls_normalize_team(jsonb) from public, anon, authenticated;
revoke all on function public.sps_rls_current_team() from public, anon, authenticated;
revoke all on function public.sps_rls_role() from public, anon, authenticated;
revoke all on function public.sps_rls_is_staff() from public, anon, authenticated;
revoke all on function public.sps_rls_is_owner() from public, anon, authenticated;
revoke all on function public.sps_rls_staff_id() from public, anon, authenticated;
revoke all on function public.sps_rls_team_has_owner(jsonb) from public, anon, authenticated;
revoke all on function public.sps_rls_app_state_target_allowed(text) from public, anon, authenticated;
revoke all on function public.sps_rls_app_state_write_allowed(text, jsonb) from public, anon, authenticated;
revoke all on function public.sps_app_state_cas(text, bigint, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.sps_app_state_delete_cas(text, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.sps_app_state_batch_cas(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.sps_rls_is_staff() to authenticated;
grant execute on function public.sps_rls_is_owner() to authenticated;
grant execute on function public.sps_rls_staff_id() to authenticated;
grant execute on function public.sps_rls_team_has_owner(jsonb) to authenticated;
grant execute on function public.sps_rls_app_state_target_allowed(text) to authenticated;
grant execute on function public.sps_rls_app_state_write_allowed(text, jsonb) to authenticated;
grant execute on function public.sps_app_state_cas(text, bigint, jsonb)
  to authenticated, service_role;
grant execute on function public.sps_app_state_delete_cas(text, bigint)
  to authenticated, service_role;
grant execute on function public.sps_app_state_batch_cas(jsonb)
  to authenticated, service_role;

-- --------------------------------------------------------------------------
-- Remove every legacy policy from protected tables. Dropping by catalog entry
-- also catches renamed/custom permissive policies, not just the original names.
-- --------------------------------------------------------------------------

do $policy_cleanup$
declare
  p record;
begin
  for p in
    select tablename, policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'app_state', 'sps_messages', 'staff_locations', 'sps_comms_log',
        'app_state_backups', 'sps_backups'
      ])
  loop
    execute pg_catalog.format(
      'drop policy if exists %I on public.%I', p.policyname, p.tablename
    );
  end loop;
end;
$policy_cleanup$;

-- Explicitly remove the historically shipped names too (idempotent and clear in
-- deployment logs, even when those policies were not present).
drop policy if exists "app_state read" on public.app_state;
drop policy if exists "app_state insert" on public.app_state;
drop policy if exists "app_state update" on public.app_state;
drop policy if exists "app_state write" on public.app_state;
drop policy if exists "anon read tracking tokens" on public.app_state;

drop policy if exists "messages read" on public.sps_messages;
drop policy if exists "messages insert" on public.sps_messages;
drop policy if exists "messages update" on public.sps_messages;

drop policy if exists "staff_locations read (authenticated)" on public.staff_locations;
drop policy if exists "staff_locations insert (authenticated)" on public.staff_locations;
drop policy if exists "staff_locations update (authenticated)" on public.staff_locations;
drop policy if exists "anon read active staff locations" on public.staff_locations;

drop policy if exists "comms_log read" on public.sps_comms_log;
drop policy if exists "comms_log insert" on public.sps_comms_log;

-- --------------------------------------------------------------------------
-- Table grants. RLS still decides which authenticated users may use them.
-- Anonymous access is revoked at the privilege layer as well as the policy layer.
-- --------------------------------------------------------------------------

revoke all on table public.app_state from public, anon, authenticated;
grant select on table public.app_state to authenticated;

-- Preserve the direct-write state captured before the migration touched the
-- table. Each privilege is restored independently so a partially restricted
-- legacy deployment is not broadened by a rerun.
do $restore_app_state_grants$
begin
  if coalesce(pg_catalog.current_setting(
    'sps_security.app_state_authenticated_insert', true
  ), 'false')::boolean then
    execute 'grant insert on table public.app_state to authenticated';
  end if;

  if coalesce(pg_catalog.current_setting(
    'sps_security.app_state_authenticated_update', true
  ), 'false')::boolean then
    execute 'grant update on table public.app_state to authenticated';
  end if;

  if coalesce(pg_catalog.current_setting(
    'sps_security.app_state_authenticated_delete', true
  ), 'false')::boolean then
    execute 'grant delete on table public.app_state to authenticated';
  end if;
end;
$restore_app_state_grants$;

-- Fail closed if a future edit accidentally broadens or removes the state that
-- was captured at transaction start.
do $assert_app_state_grants$
begin
  if not pg_catalog.has_table_privilege(
    'authenticated', 'public.app_state', 'SELECT'
  ) then
    raise exception 'app_state grant preservation failed: SELECT is missing';
  end if;

  if pg_catalog.has_table_privilege(
    'authenticated', 'public.app_state', 'INSERT'
  ) is distinct from coalesce(pg_catalog.current_setting(
    'sps_security.app_state_authenticated_insert', true
  ), 'false')::boolean then
    raise exception 'app_state grant preservation failed for INSERT';
  end if;

  if pg_catalog.has_table_privilege(
    'authenticated', 'public.app_state', 'UPDATE'
  ) is distinct from coalesce(pg_catalog.current_setting(
    'sps_security.app_state_authenticated_update', true
  ), 'false')::boolean then
    raise exception 'app_state grant preservation failed for UPDATE';
  end if;

  if pg_catalog.has_table_privilege(
    'authenticated', 'public.app_state', 'DELETE'
  ) is distinct from coalesce(pg_catalog.current_setting(
    'sps_security.app_state_authenticated_delete', true
  ), 'false')::boolean then
    raise exception 'app_state grant preservation failed for DELETE';
  end if;
end;
$assert_app_state_grants$;

grant all on table public.app_state to service_role;

revoke all on table public.sps_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.sps_messages to authenticated;
grant all on table public.sps_messages to service_role;

revoke all on table public.staff_locations from public, anon, authenticated;
grant select, insert, update, delete on table public.staff_locations to authenticated;
grant all on table public.staff_locations to service_role;

revoke all on table public.sps_comms_log from public, anon, authenticated;
grant select, insert on table public.sps_comms_log to authenticated;
grant all on table public.sps_comms_log to service_role;

revoke all on table public.app_state_backups from public, anon, authenticated;
grant select, insert, update, delete on table public.app_state_backups to authenticated;
grant all on table public.app_state_backups to service_role;

revoke all on table public.sps_backups from public, anon, authenticated;
grant select, insert, update, delete on table public.sps_backups to authenticated;
grant all on table public.sps_backups to service_role;

-- Existing projects may use identity columns or non-default sequence names. Resolve
-- the owned sequence from the catalog instead of assuming <table>_id_seq.
do $sequence_grants$
declare
  sequence_name text;
begin
  sequence_name := pg_catalog.pg_get_serial_sequence('public.sps_messages', 'id');
  if sequence_name is not null then
    execute pg_catalog.format(
      'revoke all on sequence %s from public, anon, authenticated', sequence_name
    );
    execute pg_catalog.format(
      'grant usage, select on sequence %s to authenticated', sequence_name
    );
    execute pg_catalog.format(
      'grant all on sequence %s to service_role', sequence_name
    );
  end if;

  sequence_name := pg_catalog.pg_get_serial_sequence('public.sps_comms_log', 'id');
  if sequence_name is not null then
    execute pg_catalog.format(
      'revoke all on sequence %s from public, anon, authenticated', sequence_name
    );
    execute pg_catalog.format(
      'grant usage, select on sequence %s to authenticated', sequence_name
    );
    execute pg_catalog.format(
      'grant all on sequence %s to service_role', sequence_name
    );
  end if;

  sequence_name := pg_catalog.pg_get_serial_sequence('public.app_state_backups', 'id');
  if sequence_name is not null then
    execute pg_catalog.format(
      'revoke all on sequence %s from public, anon, authenticated', sequence_name
    );
    execute pg_catalog.format(
      'grant usage, select on sequence %s to authenticated', sequence_name
    );
    execute pg_catalog.format(
      'grant all on sequence %s to service_role', sequence_name
    );
  end if;
end;
$sequence_grants$;

-- --------------------------------------------------------------------------
-- app_state
--   * verified staff can read the shared app store;
--   * verified staff can write normal operational state keys;
--   * only a verified owner can write security/admin configuration;
--   * sps_team cannot be deleted and must retain an active owner with a nonempty email.
-- --------------------------------------------------------------------------

create policy "app_state staff read"
  on public.app_state
  for select
  to authenticated
  using (public.sps_rls_is_staff());

create policy "app_state staff insert"
  on public.app_state
  for insert
  to authenticated
  with check (public.sps_rls_app_state_write_allowed(key, value));

create policy "app_state staff update"
  on public.app_state
  for update
  to authenticated
  using (public.sps_rls_app_state_target_allowed(key))
  with check (public.sps_rls_app_state_write_allowed(key, value));

create policy "app_state staff delete operational owner delete admin"
  on public.app_state
  for delete
  to authenticated
  using (
    key <> 'sps_team'
    and public.sps_rls_app_state_target_allowed(key)
  );

-- --------------------------------------------------------------------------
-- sps_messages and sps_comms_log
-- Portal clients have no direct policy. Server-mediated portal/API operations use
-- service_role and continue to bypass RLS. Staff retain the operations used by the
-- current app; comms log remains append-only to authenticated staff, while only the owner may
-- read message bodies and recipient details back.
-- --------------------------------------------------------------------------

create policy "messages staff read"
  on public.sps_messages
  for select
  to authenticated
  using (public.sps_rls_is_staff());

create policy "messages staff insert"
  on public.sps_messages
  for insert
  to authenticated
  with check (public.sps_rls_is_staff());

create policy "messages staff update"
  on public.sps_messages
  for update
  to authenticated
  using (public.sps_rls_is_staff())
  with check (public.sps_rls_is_staff());

create policy "messages owner delete"
  on public.sps_messages
  for delete
  to authenticated
  using (public.sps_rls_is_owner());

create policy "comms_log owner read"
  on public.sps_comms_log
  for select
  to authenticated
  using ((select public.sps_rls_is_owner()));

create policy "comms_log staff insert"
  on public.sps_comms_log
  for insert
  to authenticated
  with check (public.sps_rls_is_staff());

-- Full database snapshots and legacy recovery rows are more sensitive than the
-- normal operational slices. Only a verified owner may access or mutate them.
create policy "app_state_backups owner read"
  on public.app_state_backups
  for select
  to authenticated
  using (public.sps_rls_is_owner());

create policy "app_state_backups owner insert"
  on public.app_state_backups
  for insert
  to authenticated
  with check (public.sps_rls_is_owner());

create policy "app_state_backups owner update"
  on public.app_state_backups
  for update
  to authenticated
  using (public.sps_rls_is_owner())
  with check (public.sps_rls_is_owner());

create policy "app_state_backups owner delete"
  on public.app_state_backups
  for delete
  to authenticated
  using (public.sps_rls_is_owner());

create policy "sps_backups owner read"
  on public.sps_backups
  for select
  to authenticated
  using (public.sps_rls_is_owner());

create policy "sps_backups owner insert"
  on public.sps_backups
  for insert
  to authenticated
  with check (public.sps_rls_is_owner());

create policy "sps_backups owner update"
  on public.sps_backups
  for update
  to authenticated
  using (public.sps_rls_is_owner())
  with check (public.sps_rls_is_owner());

create policy "sps_backups owner delete"
  on public.sps_backups
  for delete
  to authenticated
  using (public.sps_rls_is_owner());

-- --------------------------------------------------------------------------
-- staff_locations
--   * staff may read active team locations for dispatch/live-map features;
--   * a user may insert/update/delete only their own team member id and auth uid;
--   * one legacy NULL-auth_uid row may be claimed by its matching team member;
--   * clients and anon receive no direct access.
-- --------------------------------------------------------------------------

create policy "staff_locations staff read"
  on public.staff_locations
  for select
  to authenticated
  using (public.sps_rls_is_staff());

create policy "staff_locations insert own"
  on public.staff_locations
  for insert
  to authenticated
  with check (
    public.sps_rls_is_staff()
    and auth_uid = auth.uid()
    and staff_id = public.sps_rls_staff_id()
  );

create policy "staff_locations update own"
  on public.staff_locations
  for update
  to authenticated
  using (
    public.sps_rls_is_staff()
    and staff_id = public.sps_rls_staff_id()
    and (auth_uid = auth.uid() or auth_uid is null)
  )
  with check (
    public.sps_rls_is_staff()
    and staff_id = public.sps_rls_staff_id()
    and auth_uid = auth.uid()
  );

create policy "staff_locations delete own"
  on public.staff_locations
  for delete
  to authenticated
  using (
    public.sps_rls_is_staff()
    and staff_id = public.sps_rls_staff_id()
    and auth_uid = auth.uid()
  );

-- --------------------------------------------------------------------------
-- Service-only tables: if present, remove every direct anon/authenticated policy.
-- API routes using the service-role key continue to work.
-- --------------------------------------------------------------------------

do $service_only$
declare
  table_name text;
  p record;
begin
  foreach table_name in array array[
    'qb_tokens', 'plaid_tokens', 'sps_push_tokens', 'sps_inbox'
  ]
  loop
    if pg_catalog.to_regclass('public.' || table_name) is null then
      continue;
    end if;

    execute pg_catalog.format(
      'alter table public.%I enable row level security', table_name
    );
    for p in
      select policyname
      from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = table_name
    loop
      execute pg_catalog.format(
        'drop policy if exists %I on public.%I', p.policyname, table_name
      );
    end loop;
    execute pg_catalog.format(
      'revoke all on table public.%I from public, anon, authenticated', table_name
    );
    execute pg_catalog.format(
      'grant all on table public.%I to service_role', table_name
    );
  end loop;
end;
$service_only$;

-- Website leads are a deliberate exception to the service-only rule. When this
-- table lives in the app project, anonymous visitors must be able to submit a
-- lead but must never be able to read, update, or delete any lead. Replace every
-- existing policy and privilege with one INSERT-only intake path. The service
-- role retains the read/update access used by the webhook/backfill bridge.
do $lead_intake_lockdown$
declare
  p record;
  sequence_name text;
begin
  if pg_catalog.to_regclass('public.leads') is not null then
    execute 'alter table public.leads enable row level security';

    for p in
      select policyname
      from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = 'leads'
    loop
      execute pg_catalog.format(
        'drop policy if exists %I on public.leads', p.policyname
      );
    end loop;

    execute 'revoke all on table public.leads from public, anon, authenticated';
    execute 'grant insert on table public.leads to anon';
    execute 'grant all on table public.leads to service_role';
    execute 'create policy "leads anonymous intake" on public.leads for insert to anon with check (true)';

    -- UUID/default-generated lead ids need no sequence grant. Preserve anonymous
    -- inserts on older serial-id installs without granting access to the rows.
    begin
      sequence_name := pg_catalog.pg_get_serial_sequence('public.leads', 'id');
    exception when undefined_column then
      sequence_name := null;
    end;
    if sequence_name is not null then
      execute pg_catalog.format(
        'revoke all on sequence %s from public, anon, authenticated', sequence_name
      );
      execute pg_catalog.format(
        'grant usage, select on sequence %s to anon', sequence_name
      );
      execute pg_catalog.format(
        'grant all on sequence %s to service_role', sequence_name
      );
    end if;
  end if;
end;
$lead_intake_lockdown$;

-- Fail the transaction if any direct anonymous/public policy survived on the
-- protected data surfaces.
do $assertions$
declare
  backup_owner_policy_count integer;
  lead_anon_policy_count integer;
begin
  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'app_state', 'sps_messages', 'staff_locations', 'sps_comms_log',
        'app_state_backups', 'sps_backups',
        'qb_tokens', 'plaid_tokens', 'sps_push_tokens', 'sps_inbox', 'leads'
      ])
      and ('anon' = any (roles) or 'public' = any (roles))
      and not (
        tablename = 'leads'
        and policyname = 'leads anonymous intake'
        and pg_catalog.upper(cmd) = 'INSERT'
        and roles = array['anon']::name[]
      )
  ) then
    raise exception 'RLS lockdown incomplete: an anon/public policy remains';
  end if;

  select pg_catalog.count(*)
    into backup_owner_policy_count
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = any (array['app_state_backups', 'sps_backups'])
    and roles = array['authenticated']::name[]
    and policyname::text ilike '%owner%';
  if backup_owner_policy_count <> 8 then
    raise exception 'Backup lockdown incomplete: expected eight owner-only policies';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.app_state_backups', 'SELECT')
    or pg_catalog.has_table_privilege('anon', 'public.app_state_backups', 'INSERT')
    or pg_catalog.has_table_privilege('anon', 'public.sps_backups', 'SELECT')
    or pg_catalog.has_table_privilege('anon', 'public.sps_backups', 'INSERT')
  then
    raise exception 'Backup lockdown incomplete: anonymous table privileges remain';
  end if;

  if pg_catalog.to_regclass('public.leads') is not null then
    if not pg_catalog.has_table_privilege('anon', 'public.leads', 'INSERT')
      or pg_catalog.has_table_privilege('anon', 'public.leads', 'SELECT')
      or pg_catalog.has_table_privilege('anon', 'public.leads', 'UPDATE')
      or pg_catalog.has_table_privilege('anon', 'public.leads', 'DELETE')
    then
      raise exception 'Lead intake lockdown incomplete: anonymous privileges are not INSERT-only';
    end if;

    select pg_catalog.count(*)
      into lead_anon_policy_count
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'leads'
      and 'anon' = any (roles);
    if lead_anon_policy_count <> 1 then
      raise exception 'Lead intake lockdown incomplete: expected one anonymous INSERT policy';
    end if;
  end if;
end;
$assertions$;

commit;

-- Post-deploy checks (read-only; safe to run separately):
--
-- select public.sps_rls_normalize_team(value) as parsed_team
-- from public.app_state where key = 'sps_team';
--
-- select tablename, policyname, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'app_state','app_state_backups','sps_backups','sps_messages',
--     'staff_locations','sps_comms_log','leads'
--   )
-- order by tablename, policyname;
--
-- select staff_id, auth_uid, is_active, updated_at
-- from public.staff_locations order by staff_id;
--
-- select key, version, updated_at
-- from public.app_state order by key;
