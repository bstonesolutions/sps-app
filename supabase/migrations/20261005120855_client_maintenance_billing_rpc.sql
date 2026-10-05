-- LOCAL REVIEW ONLY. Apply after the app-state concurrency/batch migrations.
-- Move the large sps_clients JSON projection and replacement into PostgreSQL.
-- These server-only RPCs never return the roster and cannot choose arbitrary keys.
-- They keep the existing batch CAS transaction/version trigger as the write authority.

begin;

do $preflight$
begin
  if pg_catalog.to_regprocedure('public.sps_app_state_batch_cas(jsonb)') is null then
    raise exception 'Install the app-state batch CAS migration before prepaid billing RPCs';
  end if;
end;
$preflight$;

create or replace function public.sps_client_maintenance_billing_snapshot(p_client_id text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $function$
declare
  roster jsonb;
  billing jsonb;
  roster_version bigint;
  billing_version bigint;
  billing_exists boolean;
  match_count integer;
  matched_client jsonb;
  depth integer;
begin
  if p_client_id is null or p_client_id = '' or p_client_id <> pg_catalog.btrim(p_client_id)
    or pg_catalog.length(p_client_id) > 220 then
    raise exception 'client_id_invalid' using errcode = '22023';
  end if;

  select state.value, state.version into roster, roster_version
  from public.app_state as state where state.key = 'sps_clients';
  if not found or roster_version < 1 then
    raise exception 'shared_clients_invalid' using errcode = '22023';
  end if;
  begin
    for depth in 1..2 loop
      exit when pg_catalog.jsonb_typeof(roster) is distinct from 'string';
      roster := (roster #>> '{}')::jsonb;
    end loop;
  exception when invalid_text_representation then
    raise exception 'shared_clients_invalid' using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(roster) is distinct from 'array' then
    raise exception 'shared_clients_invalid' using errcode = '22023';
  end if;

  select pg_catalog.count(*)::integer into match_count
  from pg_catalog.jsonb_array_elements(roster) as entries(item)
  where pg_catalog.jsonb_typeof(item) = 'object' and item ->> 'id' = p_client_id;
  if match_count = 1 then
    select pg_catalog.jsonb_build_object('id', item -> 'id', 'name', item -> 'name')
      || case when item ? 'maintenanceBilling' then pg_catalog.jsonb_build_object('maintenanceBilling', item -> 'maintenanceBilling') else '{}'::jsonb end
      into matched_client
    from pg_catalog.jsonb_array_elements(roster) as entries(item)
    where pg_catalog.jsonb_typeof(item) = 'object' and item ->> 'id' = p_client_id;
  end if;

  select state.value, state.version into billing, billing_version
  from public.app_state as state where state.key = 'sps_maintenance_billing';
  billing_exists := found;
  if not billing_exists then
    billing_version := 0;
    billing := null;
  else
    if billing_version < 1 then
      raise exception 'shared_maintenance_billing_invalid' using errcode = '22023';
    end if;
    begin
      for depth in 1..2 loop
        exit when pg_catalog.jsonb_typeof(billing) is distinct from 'string';
        billing := (billing #>> '{}')::jsonb;
      end loop;
    exception when invalid_text_representation then
      raise exception 'shared_maintenance_billing_invalid' using errcode = '22023';
    end;
    if pg_catalog.jsonb_typeof(billing) is distinct from 'object' then
      raise exception 'shared_maintenance_billing_invalid' using errcode = '22023';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'client', matched_client, 'match_count', match_count,
    'clients_version', roster_version, 'billing_exists', billing_exists,
    'billing_version', billing_version, 'ledger', billing
  );
end;
$function$;

create or replace function public.sps_client_maintenance_billing_cas(
  p_client_id text,
  p_expected_clients_version bigint,
  p_expected_billing_version bigint,
  p_maintenance_billing jsonb,
  p_ledger jsonb
)
returns table (
  applied boolean,
  outcome text,
  conflict_key text,
  current_versions jsonb,
  client jsonb
)
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  roster jsonb;
  billing jsonb;
  roster_version bigint;
  billing_version bigint;
  roster_depth integer := 0;
  billing_depth integer := 0;
  depth integer;
  match_count integer;
  client_index text;
  matched_client jsonb;
  next_client jsonb;
  next_roster jsonb;
  next_billing jsonb;
  canonical_policy jsonb := nullif(p_maintenance_billing, 'null'::jsonb);
  cas_result record;
begin
  if p_client_id is null or p_client_id = '' or p_client_id <> pg_catalog.btrim(p_client_id)
    or pg_catalog.length(p_client_id) > 220 then
    raise exception 'client_id_invalid' using errcode = '22023';
  end if;
  if p_expected_clients_version is null or p_expected_clients_version < 1
    or p_expected_billing_version is null or p_expected_billing_version < 0 then
    raise exception 'app_state_expected_version_invalid' using errcode = '22023';
  end if;
  if canonical_policy is not null and (
    pg_catalog.jsonb_typeof(canonical_policy) <> 'object'
    or canonical_policy ->> 'mode' is distinct from 'prepaid'
  ) then
    raise exception 'maintenance_policy_invalid' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_ledger) is distinct from 'object'
    or p_ledger ->> 'version' is distinct from '2'
    or pg_catalog.jsonb_typeof(p_ledger -> 'policies') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_ledger -> 'allocations') is distinct from 'object'
    or nullif(p_ledger -> 'policies' -> p_client_id, 'null'::jsonb) is distinct from canonical_policy then
    raise exception 'maintenance_ledger_invalid' using errcode = '22023';
  end if;

  -- One statement reads both versions; batch CAS repeats their checks atomically.
  select clients.value, clients.version, ledger.value, coalesce(ledger.version, 0)
  into roster, roster_version, billing, billing_version
  from public.app_state as clients
  left join public.app_state as ledger on ledger.key = 'sps_maintenance_billing'
  where clients.key = 'sps_clients';
  if not found or roster_version < 1 then
    raise exception 'shared_clients_invalid' using errcode = '22023';
  end if;
  if roster_version <> p_expected_clients_version or billing_version <> p_expected_billing_version then
    applied := false;
    outcome := 'conflict';
    conflict_key := case when roster_version <> p_expected_clients_version then 'sps_clients' else 'sps_maintenance_billing' end;
    current_versions := pg_catalog.jsonb_build_object('sps_clients', roster_version, 'sps_maintenance_billing', billing_version);
    client := null;
    return next;
    return;
  end if;

  begin
    while pg_catalog.jsonb_typeof(roster) = 'string' and roster_depth < 2 loop
      roster := (roster #>> '{}')::jsonb;
      roster_depth := roster_depth + 1;
    end loop;
  exception when invalid_text_representation then
    raise exception 'shared_clients_invalid' using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(roster) is distinct from 'array' then
    raise exception 'shared_clients_invalid' using errcode = '22023';
  end if;
  if billing_version = 0 then
    -- New rows follow the application's JSON-string-inside-jsonb representation.
    billing_depth := 1;
  else
    begin
      while pg_catalog.jsonb_typeof(billing) = 'string' and billing_depth < 2 loop
        billing := (billing #>> '{}')::jsonb;
        billing_depth := billing_depth + 1;
      end loop;
    exception when invalid_text_representation then
      raise exception 'shared_maintenance_billing_invalid' using errcode = '22023';
    end;
    if pg_catalog.jsonb_typeof(billing) is distinct from 'object' then
      raise exception 'shared_maintenance_billing_invalid' using errcode = '22023';
    end if;
  end if;

  select pg_catalog.count(*)::integer into match_count
  from pg_catalog.jsonb_array_elements(roster) as entries(item)
  where pg_catalog.jsonb_typeof(item) = 'object' and item ->> 'id' = p_client_id;
  if match_count <> 1 then
    raise exception 'client_match_count_invalid' using errcode = '22023';
  end if;
  select item, (ordinality - 1)::text into matched_client, client_index
  from pg_catalog.jsonb_array_elements(roster) with ordinality as entries(item, ordinality)
  where pg_catalog.jsonb_typeof(item) = 'object' and item ->> 'id' = p_client_id;

  next_client := matched_client - 'maintenanceBilling';
  if canonical_policy is not null then
    next_client := pg_catalog.jsonb_set(next_client, array['maintenanceBilling'], canonical_policy, true);
  end if;
  next_roster := pg_catalog.jsonb_set(roster, array[client_index], next_client, false);
  next_billing := p_ledger;
  -- Retain decoded, normally encoded, and double-encoded historical envelopes.
  for depth in 1..roster_depth loop next_roster := pg_catalog.to_jsonb(next_roster::text); end loop;
  for depth in 1..billing_depth loop next_billing := pg_catalog.to_jsonb(next_billing::text); end loop;

  select result.* into cas_result
  from public.sps_app_state_batch_cas(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('key', 'sps_clients', 'expected_version', p_expected_clients_version, 'value', next_roster),
    pg_catalog.jsonb_build_object('key', 'sps_maintenance_billing', 'expected_version', p_expected_billing_version, 'value', next_billing)
  )) as result;
  if not found then raise exception 'app_state_batch_cas_invalid_response'; end if;
  applied := cas_result.applied;
  outcome := cas_result.outcome;
  conflict_key := cas_result.conflict_key;
  current_versions := cas_result.current_versions;
  client := case when applied then pg_catalog.jsonb_build_object('id', next_client -> 'id', 'name', next_client -> 'name')
    || case when next_client ? 'maintenanceBilling' then pg_catalog.jsonb_build_object('maintenanceBilling', next_client -> 'maintenanceBilling') else '{}'::jsonb end
    else null end;
  return next;
end;
$function$;

alter function public.sps_client_maintenance_billing_snapshot(text) owner to postgres;
alter function public.sps_client_maintenance_billing_cas(text, bigint, bigint, jsonb, jsonb) owner to postgres;
revoke all on function public.sps_client_maintenance_billing_snapshot(text) from public, anon, authenticated, service_role;
revoke all on function public.sps_client_maintenance_billing_cas(text, bigint, bigint, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.sps_client_maintenance_billing_snapshot(text) to service_role;
grant execute on function public.sps_client_maintenance_billing_cas(text, bigint, bigint, jsonb, jsonb) to service_role;

commit;
