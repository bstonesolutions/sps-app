-- SPS Way: add atomic check-only fences to multi-row app_state commits.
-- Safe to run more than once after APP-STATE-CONCURRENCY-MIGRATION.sql.
-- Existing callers remain compatible because check_only is optional and defaults to false.

begin;

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

    if operation ? 'check_only'
      and pg_catalog.jsonb_typeof(operation -> 'check_only') <> 'boolean'
    then
      raise exception 'Batch check_only must be a boolean'
        using errcode = '22023';
    end if;
    if coalesce((operation ->> 'check_only')::boolean, false)
      and expected_version = 0
    then
      raise exception 'Batch check_only requires an existing positive version'
        using errcode = '22023';
    end if;

    if coalesce((operation ->> 'check_only')::boolean, false) then
      if operation ? 'value' then
        raise exception 'Batch check_only operations may not include a value'
          using errcode = '22023';
      end if;
    else
      if not (operation ? 'value') then
        raise exception 'Every batch write operation requires a value'
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
    end if;
  end loop;

  select pg_catalog.count(*), pg_catalog.count(distinct item ->> 'key')
  into operation_count, unique_key_count
  from pg_catalog.jsonb_array_elements(p_operations) as items(item);
  if operation_count <> unique_key_count then
    raise exception 'Batch operations may not contain duplicate keys'
      using errcode = '22023';
  end if;

  -- Keep the inexpensive early conflict response. The locked block below repeats every check,
  -- so a writer racing this read still cannot cause a partial commit.
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
    -- Every referenced row is locked in key order. Check-only rows participate in the same
    -- transaction but skip the JSON replacement and therefore keep their version unchanged.
    for operation in
      select item
      from pg_catalog.jsonb_array_elements(p_operations) as items(item)
      order by item ->> 'key'
    loop
      operation_key := operation ->> 'key';
      active_key := operation_key;
      expected_version := (operation ->> 'expected_version')::bigint;

      if coalesce((operation ->> 'check_only')::boolean, false) then
        select state.version
        into actual_version
        from public.app_state as state
        where state.key = operation_key
        for update;
        if not found or actual_version <> expected_version then
          raise exception 'batch version conflict' using errcode = 'P0B01';
        end if;
      elsif expected_version = 0 then
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
    -- The nested block rolls back every earlier update before returning the conflict.
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

alter function public.sps_app_state_batch_cas(jsonb) owner to postgres;
revoke all on function public.sps_app_state_batch_cas(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.sps_app_state_batch_cas(jsonb)
  to authenticated, service_role;

commit;

-- Verification: check_only_support should be true after this migration.
select pg_catalog.strpos(
  pg_catalog.pg_get_functiondef(
    'public.sps_app_state_batch_cas(jsonb)'::regprocedure
  ),
  'check_only'
) > 0 as check_only_support;
