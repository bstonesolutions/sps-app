-- ============================================================================
-- SPS Way — app_state optimistic concurrency (additive rollout)
-- ============================================================================
-- Run this on an existing project BEFORE deploying the version-aware client.
-- It is a standalone phase-zero migration and is safe to run before or after
-- SECURITY-RLS-MIGRATION.sql. The later security migration recreates the same
-- role/CAS helpers and performs the actual policy lockdown.
--
-- This first stage deliberately does NOT revoke authenticated table writes.
-- Existing tabs can continue working during rollout, while the trigger makes
-- every legacy/service-role update advance the row version. After every client
-- writer uses the CAS RPCs, run APP-STATE-CONCURRENCY-ENFORCE.sql.
--
-- Expected-version contract:
--   * write with expected_version = 0 inserts only when the key is absent;
--   * write with expected_version > 0 updates only that exact version;
--   * delete requires expected_version > 0 and never permits sps_team;
--   * owner batch operations apply every key or roll back every key;
--   * applied=false means the caller must refetch and merge, never blind-retry.
-- ============================================================================

begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.app_state') is null then
    raise exception 'Run supabase-setup.sql before the concurrency phase-zero migration';
  end if;
end;
$preflight$;

alter table public.app_state
  add column if not exists version bigint;

-- Dropping first makes a rerun able to repair a legacy/null version without the
-- update trigger replacing the repair value.
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

-- Own all version/timestamp changes at the database boundary. In particular,
-- service-role and temporarily supported legacy direct updates cannot leave a
-- version unchanged or supply a forged version.
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

-- Install the same fail-closed roster helpers used by the later RLS migration.
-- They authorize the CAS RPCs immediately, while existing direct table policies
-- and grants remain completely untouched during this compatibility phase.
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

    return team_role;
  end if;

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

alter function public.sps_rls_normalize_team(jsonb) owner to postgres;
alter function public.sps_rls_current_team() owner to postgres;
alter function public.sps_rls_role() owner to postgres;
alter function public.sps_rls_is_staff() owner to postgres;
alter function public.sps_rls_is_owner() owner to postgres;
alter function public.sps_rls_team_has_owner(jsonb) owner to postgres;

revoke all on function public.sps_rls_normalize_team(jsonb) from public, anon, authenticated;
revoke all on function public.sps_rls_current_team() from public, anon, authenticated;
revoke all on function public.sps_rls_role() from public, anon, authenticated;
revoke all on function public.sps_rls_is_staff() from public, anon, authenticated;
revoke all on function public.sps_rls_is_owner() from public, anon, authenticated;
revoke all on function public.sps_rls_team_has_owner(jsonb) from public, anon, authenticated;

-- Keep these grants compatible with an already-installed RLS migration. The
-- helpers return only booleans and do not expose the team roster.
grant execute on function public.sps_rls_is_staff() to authenticated;
grant execute on function public.sps_rls_is_owner() to authenticated;
grant execute on function public.sps_rls_team_has_owner(jsonb) to authenticated;

-- Keep the owner-only key list in one authorization helper shared by RLS and
-- the SECURITY DEFINER RPC. A non-empty team remains authoritative through the
-- existing sps_rls_is_staff()/sps_rls_is_owner() functions.
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

alter function public.sps_rls_app_state_target_allowed(text) owner to postgres;
alter function public.sps_rls_app_state_write_allowed(text, jsonb) owner to postgres;

revoke all on function public.sps_rls_app_state_target_allowed(text)
  from public, anon, authenticated;
revoke all on function public.sps_rls_app_state_write_allowed(text, jsonb)
  from public, anon, authenticated;

-- Authenticated needs EXECUTE because these helpers are evaluated by RLS.
grant execute on function public.sps_rls_app_state_target_allowed(text)
  to authenticated;
grant execute on function public.sps_rls_app_state_write_allowed(text, jsonb)
  to authenticated;

-- Phase zero intentionally does not create, drop, or replace any table policy.
-- Existing browser/native builds retain exactly the direct access they had at
-- transaction start. SECURITY-RLS-MIGRATION.sql performs the policy replacement
-- only after the version-aware clients and scoped portal bridge are deployed.

-- Atomic insert/update compare-and-swap. It returns metadata only; an
-- authenticated caller refetches value through the staff SELECT RLS policy on a
-- conflict. service_role is allowed for trusted API writers and must preserve
-- an active owner when replacing sps_team.
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

-- Version-checked delete for the uncommon app_state key deletion path. sps_team
-- is undeletable for authenticated and service-role callers alike.
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

alter function public.sps_app_state_cas(text, bigint, jsonb) owner to postgres;
alter function public.sps_app_state_delete_cas(text, bigint) owner to postgres;
alter function public.sps_app_state_batch_cas(jsonb) owner to postgres;

-- PostgreSQL grants new functions to PUBLIC by default. Remove that grant and
-- expose only to verified authenticated callers and trusted server routes.
revoke all on function public.sps_app_state_cas(text, bigint, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.sps_app_state_delete_cas(text, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.sps_app_state_batch_cas(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.sps_app_state_cas(text, bigint, jsonb)
  to authenticated, service_role;
grant execute on function public.sps_app_state_delete_cas(text, bigint)
  to authenticated, service_role;
grant execute on function public.sps_app_state_batch_cas(jsonb)
  to authenticated, service_role;

-- No table grants or policies are changed in this additive stage. That keeps
-- rollout safe and ensures a rerun after enforcement cannot reopen direct writes.

commit;
