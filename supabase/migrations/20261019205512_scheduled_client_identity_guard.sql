-- Preserve existing client identities used by the saved schedule, including
-- clients who do not yet have a completed report. This extends the activated
-- report guard, so old direct writers and current CAS writers share the rule.
-- No missing client is invented from a stop, and no schedule row is rewritten.
-- Restricted stop/report RPCs keep their memory-bounded validated fast path:
-- they already prove that client identity/profile fields and other clients are
-- unchanged before enabling it.
begin;

create or replace function public.sps_stop_guard_client_items(p_old jsonb, p_new jsonb, p_context jsonb)
returns setof jsonb language plpgsql security definer set search_path = pg_catalog as $f$
declare
  incoming jsonb; prior jsonb; item jsonb; prior_item jsonb; old_by_id jsonb; incoming_ids jsonb;
  history jsonb; old_history jsonb; client_id text; rid text; target text := p_context->>'receipt';
  mode text := p_context->>'mode'; old_clients jsonb := coalesce(p_old, '[]');
  schedule_value jsonb; scheduled_ids jsonb := '{}';
begin
  if jsonb_typeof(old_clients) <> 'array' or jsonb_typeof(p_new) <> 'array' then
    raise exception 'stop_clients_shape_invalid' using errcode='22023';
  end if;
  -- Reject duplicate identities rather than attach a protected report to two clients.
  if exists (select 1 from jsonb_array_elements(p_new) c
    group by c->>'id' having count(*) > 1) then
    raise exception 'stop_clients_identity_ambiguous' using errcode='22023';
  end if;
  select coalesce(jsonb_object_agg(c->>'id',c),'{}') into old_by_id from jsonb_array_elements(old_clients) c where c->>'id' is not null;
  select coalesce(jsonb_object_agg(c->>'id',true),'{}') into incoming_ids from jsonb_array_elements(p_new) c where c->>'id' is not null;
  -- Consult the saved schedule only when a snapshot omits existing clients. Do
  -- not lock a second app_state row here: legacy writes enter with the client
  -- row already locked, while server batch writers own their sorted lock order.
  -- This covers references committed before the write, not a concurrently
  -- created stop whose client has never reached the server. New-client flows
  -- must still confirm the client save before allowing a stop to be scheduled.
  if exists (select 1 from jsonb_array_elements(old_clients) c
    where c->>'id' is not null and not incoming_ids ? (c->>'id')) then
    select public.sps_stop_state_decode(a.value) into schedule_value
      from public.app_state a where a.key='sps_schedule';
    if schedule_value is not null then
      if jsonb_typeof(schedule_value) is distinct from 'array' then
        raise exception 'client_reference_schedule_invalid' using errcode='22023';
      end if;
      select coalesce(jsonb_object_agg(refs.client_id,true),'{}') into scheduled_ids
        from (
          select coalesce(s.value->>'clientId',s.value->>'id') as client_id
          from jsonb_array_elements(schedule_value) d
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(d->'stops')='array' then d->'stops' else '[]'::jsonb end
          ) s(value)
        ) refs where nullif(refs.client_id,'') is not null;
    end if;
  end if;
  for incoming in select value from jsonb_array_elements(p_new) loop
    client_id := incoming->>'id';
    prior := old_by_id->client_id;
    -- A blank label cannot be a useful rename. Keep the last saved name even
    -- when an older whole-roster writer omits it; all nonblank renames and
    -- unrelated incoming fields retain their ordinary save behavior.
    if jsonb_typeof(prior->'name')='string' and prior->>'name' ~ '[^[:space:]]'
      and (jsonb_typeof(incoming->'name') is distinct from 'string'
        or not coalesce(incoming->>'name' ~ '[^[:space:]]',false)) then
      incoming := jsonb_set(incoming,'{name}',prior->'name');
    end if;
    old_history := case when jsonb_typeof(prior->'history')='array' then prior->'history' else '[]'::jsonb end;
    history := '[]';
    for item in select value from jsonb_array_elements(case when jsonb_typeof(incoming->'history')='array' then incoming->'history' else '[]'::jsonb end) loop
      rid := nullif(item->>'completionReceiptId','');
      if rid is null then history := history || jsonb_build_array(item); continue; end if;
      if exists (select 1 from public.sps_stop_report_reversals r where r.receipt_id=rid) then continue; end if;
      if target=rid and mode in ('complete','edit') then
        history := history || jsonb_build_array(item); continue;
      end if;
      if target=rid and mode='reverse' then continue; end if;
      select value into prior_item from jsonb_array_elements(old_history) where value->>'completionReceiptId'=rid limit 1;
      if prior_item is not null and not exists (select 1 from jsonb_array_elements(history) h where h->>'completionReceiptId'=rid) then
        history := history || jsonb_build_array(prior_item);
      end if;
      -- An unknown receipt cannot be created by a generic snapshot write.
    end loop;
    for item in select value from jsonb_array_elements(old_history) loop
      rid := nullif(item->>'completionReceiptId','');
      if rid is null or (target=rid and mode='reverse') then continue; end if;
      if exists (select 1 from public.sps_stop_report_reversals r where r.receipt_id=rid) then continue; end if;
      if not exists (select 1 from jsonb_array_elements(history) h where h->>'completionReceiptId'=rid) then
        history := history || jsonb_build_array(item);
      end if;
    end loop;
    if jsonb_typeof(incoming->'history')='array' or jsonb_array_length(history)>0 then incoming := jsonb_set(incoming, '{history}', history); end if;
    return next incoming;
  end loop;
  -- A stale roster cannot remove a client that the saved schedule still uses.
  -- Keep the existing accepted-report protection as an independent condition.
  -- Unreferenced clients without accepted reports retain existing deletion behavior.
  for prior in select value from jsonb_array_elements(old_clients) loop
    if not coalesce(incoming_ids ? (prior->>'id'),false)
      and (coalesce(scheduled_ids ? (prior->>'id'),false)
        or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(prior->'history')='array' then prior->'history' else '[]'::jsonb end) h
        where nullif(h->>'completionReceiptId','') is not null
          and not (coalesce(target=h->>'completionReceiptId',false) and mode='reverse')
          and not exists (select 1 from public.sps_stop_report_reversals r where r.receipt_id=h->>'completionReceiptId'))) then
      return next prior;
    end if;
  end loop;
  return;
end $f$;
alter function public.sps_stop_guard_client_items(jsonb,jsonb,jsonb) owner to postgres;
revoke all on function public.sps_stop_guard_client_items(jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;
commit;
