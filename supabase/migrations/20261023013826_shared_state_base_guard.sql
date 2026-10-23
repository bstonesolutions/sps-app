-- Existing clients and scheduled work require a proven original base for edits.
-- Legacy snapshots may append stable identities but cannot replace saved work.
begin;

create table public.sps_shared_write_candidates (
  id bigint generated always as identity primary key,
  state_key text not null check(state_key in ('sps_clients','sps_schedule')),
  entity_id text not null,
  actor_id text not null,
  before_version bigint not null,
  before_fields jsonb,
  proposed_fields jsonb,
  removed_fields jsonb not null default '[]',
  proposed_delete boolean not null default false,
  reason text not null,
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz
);
create index sps_shared_write_candidates_pending on public.sps_shared_write_candidates(state_key,id) where resolved_at is null;
create table public.sps_shared_identity_tombstones (
  state_key text not null,
  entity_id text not null,
  deleted_at timestamptz not null default clock_timestamp(),
  actor_id text not null,
  primary key(state_key,entity_id)
);
alter table public.sps_shared_write_candidates enable row level security;
alter table public.sps_shared_identity_tombstones enable row level security;
revoke all on public.sps_shared_write_candidates,public.sps_shared_identity_tombstones from public,anon,authenticated,service_role;
revoke all on sequence public.sps_shared_write_candidates_id_seq from public,anon,authenticated,service_role;

-- Compare generic app_state payloads without requiring every section to be an
-- array. Preserve actual JSON string scalars when another decode is impossible.
create function public.sps_shared_state_json_content(p_value jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $f$
declare v jsonb:=p_value; i integer:=0;
begin
  while jsonb_typeof(v)='string' and i<2 loop
    begin v:=(v#>>'{}')::jsonb;
    exception when invalid_text_representation then return v; end;
    i:=i+1;
  end loop;
  return v;
end $f$;

create function public.sps_shared_state_decode(p_value jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $f$
declare v jsonb:=p_value; i integer:=0;
begin
  while jsonb_typeof(v)='string' and i<2 loop v:=(v#>>'{}')::jsonb; i:=i+1; end loop;
  if jsonb_typeof(v) is distinct from 'array' then raise exception 'shared_state_array_required' using errcode='22023'; end if;
  return v;
end $f$;

-- Stable identities let a new stop be appended without granting permission to
-- rewrite another stop, move its date, or reorder the saved route.
create function public.sps_shared_state_entities(p_key text,p_value jsonb)
returns table(entity_id text,body jsonb)
language plpgsql immutable set search_path=pg_catalog as $f$
declare rows jsonb:=public.sps_shared_state_decode(p_value); item jsonb; stop jsonb; ids jsonb:='[]'; order_ids jsonb;
  seen jsonb:='{}'; stop_seen jsonb:='{}'; identity text; day text; ordinal integer;
begin
  if p_key='sps_clients' then
    for item in select value from jsonb_array_elements(rows) loop
      identity:=nullif(item->>'id','');
      if jsonb_typeof(item)<>'object' or identity is null or seen ? identity then raise exception 'shared_client_identity_invalid' using errcode='22023'; end if;
      seen:=jsonb_set(seen,array[identity],'true'::jsonb); ids:=ids||jsonb_build_array(identity);
      entity_id:='client:'||identity; body:=item; return next;
    end loop;
    entity_id:='order:clients'; body:=ids; return next;
  elsif p_key='sps_schedule' then
    for item in select value from jsonb_array_elements(rows) loop
      day:=nullif(item->>'date','');
      if jsonb_typeof(item)<>'object' or day is null or seen ? day
        or (item ? 'stops' and jsonb_typeof(item->'stops')<>'array') then raise exception 'shared_schedule_day_invalid' using errcode='22023'; end if;
      seen:=jsonb_set(seen,array[day],'true'::jsonb); ids:=ids||jsonb_build_array(day);
      entity_id:='day:'||day; body:=item-'stops'; return next;
      order_ids:='[]'; ordinal:=0;
      for stop in select value from jsonb_array_elements(coalesce(item->'stops','[]')) loop
        ordinal:=ordinal+1; identity:=nullif(stop->>'sid','');
        if identity is null then identity:='anonymous:'||day||':'||ordinal;
        else identity:='stop:'||identity; end if;
        if stop_seen ? identity then raise exception 'shared_stop_identity_ambiguous' using errcode='22023'; end if;
        stop_seen:=jsonb_set(stop_seen,array[identity],'true'::jsonb); order_ids:=order_ids||jsonb_build_array(identity);
        entity_id:=identity; body:=jsonb_build_object('date',day,'stop',stop); return next;
      end loop;
      entity_id:='order:day:'||day; body:=order_ids; return next;
    end loop;
    entity_id:='order:days'; body:=ids; return next;
  else raise exception 'shared_state_key_not_allowed' using errcode='22023'; end if;
end $f$;

create function public.sps_shared_state_unsafe(p_key text,p_before jsonb,p_after jsonb)
returns table(entity_id text,before_value jsonb,proposed_value jsonb,reason text)
language plpgsql stable security definer set search_path=pg_catalog set row_security=off as $f$
declare old_map jsonb; new_map jsonb; entry record; retained jsonb;
begin
  select coalesce(jsonb_object_agg(e.entity_id,e.body),'{}') into old_map from public.sps_shared_state_entities(p_key,p_before) e;
  select coalesce(jsonb_object_agg(e.entity_id,e.body),'{}') into new_map from public.sps_shared_state_entities(p_key,p_after) e;
  for entry in select key,value from jsonb_each(old_map) loop
    entity_id:=entry.key; before_value:=entry.value; proposed_value:=new_map->entry.key;
    if entry.key like 'order:%' and jsonb_typeof(proposed_value)='array' then
      select coalesce(jsonb_agg(e.value order by e.ordinality),'[]') into retained from jsonb_array_elements(proposed_value) with ordinality e(value,ordinality)
        where entry.value @> jsonb_build_array(e.value);
      if retained=entry.value then continue; end if;
    elsif proposed_value=entry.value then continue; end if;
    reason:=case when not new_map ? entry.key then 'legacy-omission' else 'legacy-replacement' end; return next;
  end loop;
  for entry in select key,value from jsonb_each(new_map) where not old_map ? key loop
    entity_id:=entry.key; before_value:=null; proposed_value:=entry.value;
    if exists(select 1 from public.sps_shared_identity_tombstones t where t.state_key=p_key and t.entity_id=entry.key) then
      reason:='deleted-identity-replay'; return next;
    elsif entry.key like 'anonymous:%' then reason:='new-stop-needs-stable-id'; return next;
    elsif p_key='sps_clients' and entry.key like 'client:%' and (
      jsonb_typeof(entry.value->'name') is distinct from 'string' or not coalesce(entry.value->>'name' ~ '[^[:space:]]',false)
    ) then reason:='new-client-needs-name'; return next;
    end if;
  end loop;
end $f$;

create function public.sps_shared_state_journal(p_key text,p_before jsonb,p_after jsonb,p_version bigint,p_actor text)
returns void language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare change record; old_fields jsonb; new_fields jsonb; removed jsonb; old_map jsonb; new_map jsonb;
begin
  select coalesce(jsonb_object_agg(e.entity_id,e.body),'{}') into old_map from public.sps_shared_state_entities(p_key,p_before) e;
  select coalesce(jsonb_object_agg(e.entity_id,e.body),'{}') into new_map from public.sps_shared_state_entities(p_key,p_after) e;
  -- A rejected mixed snapshot may also contain a legitimate new client/stop.
  -- Retain every changed entity, not only the change that blocked the write.
  for change in select coalesce(o.key,n.key) entity_id,o.value before_value,n.value proposed_value,
    case when o.key is null then 'legacy-addition' when n.key is null then 'legacy-omission' else 'legacy-replacement' end reason
    from jsonb_each(old_map) o full join jsonb_each(new_map) n on n.key=o.key where o.value is distinct from n.value loop
    if jsonb_typeof(change.before_value)='object' and jsonb_typeof(change.proposed_value)='object' then
      select coalesce(jsonb_object_agg(e.key,e.value),'{}') into old_fields from jsonb_each(change.before_value) e
        where not change.proposed_value ? e.key or e.value is distinct from change.proposed_value->e.key;
      select coalesce(jsonb_object_agg(e.key,e.value),'{}') into new_fields from jsonb_each(change.proposed_value) e
        where not change.before_value ? e.key or e.value is distinct from change.before_value->e.key;
      select coalesce(jsonb_agg(e.key),'[]') into removed from jsonb_object_keys(change.before_value) e(key) where not change.proposed_value ? e.key;
    else old_fields:=change.before_value; new_fields:=change.proposed_value; removed:='[]'; end if;
    if not exists(select 1 from public.sps_shared_write_candidates c where c.state_key=p_key and c.entity_id=change.entity_id and c.resolved_at is null
      and c.before_fields is not distinct from old_fields and c.proposed_fields is not distinct from new_fields and c.removed_fields=removed
      and c.proposed_delete=(change.proposed_value is null) and c.reason=change.reason) then
      insert into public.sps_shared_write_candidates(state_key,entity_id,actor_id,before_version,before_fields,proposed_fields,removed_fields,proposed_delete,reason)
        values(p_key,change.entity_id,coalesce(nullif(p_actor,''),'unknown-device'),p_version,old_fields,new_fields,removed,change.proposed_value is null,change.reason);
    end if;
  end loop;
end $f$;

create function public.sps_shared_state_trusted(p_key text) returns boolean
language plpgsql stable set search_path=pg_catalog as $f$
declare context jsonb; stop_context jsonb;
begin
  if current_setting('role',true) is distinct from 'service_role' or coalesce(auth.role(),'')<>'service_role' then return false; end if;
  context:=coalesce(nullif(current_setting('sps.shared_state_write',true),'')::jsonb,'{}');
  if context->'keys' ? p_key then return true; end if;
  stop_context:=coalesce(nullif(current_setting('sps.stop_report_write',true),'')::jsonb,'{}');
  return p_key in ('sps_clients','sps_schedule') and stop_context->>'mode' in ('complete','edit','reverse');
end $f$;

-- The accepted-report guard remains in force for exact client patches.
-- Permit only validated portal rating metadata to differ on an existing receipt.
create function public.sps_shared_portal_rating_allowed(p_before jsonb,p_after jsonb)
returns boolean language plpgsql stable set search_path=pg_catalog as $f$
declare context jsonb; rating_fields text[]:=array['clientRating','clientFeedback','ratedAt','portalRatingAlertId'];
begin
  if current_setting('role',true) is distinct from 'service_role' or coalesce(auth.role(),'')<>'service_role' then return false; end if;
  context:=coalesce(nullif(current_setting('sps.shared_state_write',true),'')::jsonb,'{}');
  return coalesce(context->'keys' ? 'sps_clients',false)
    and jsonb_typeof(p_before)='object' and jsonb_typeof(p_after)='object'
    and (p_before-rating_fields)=(p_after-rating_fields);
end $f$;

create or replace function public.sps_stop_guard_client_items(p_old jsonb, p_new jsonb, p_context jsonb)
returns setof jsonb language plpgsql security definer set search_path = pg_catalog as $f$
declare
  incoming jsonb; prior jsonb; item jsonb; prior_item jsonb; old_by_id jsonb; incoming_ids jsonb;
  history jsonb; old_history jsonb; client_id text; rid text; target text := p_context->>'receipt';
  mode text := p_context->>'mode'; old_clients jsonb := coalesce(p_old, '[]');
  schedule_value jsonb; scheduled_ids jsonb := '{}'; registered_ids jsonb := '{}';
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
    select coalesce(jsonb_object_agg(r.client_id,true),'{}') into registered_ids
      from public.sps_client_creation_registry r;
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
        -- Portal ratings are independent of accepted work. Only an exact
        -- scoped server patch may change these four fields; notes/photos and
        -- every completion/accounting field still use the accepted report.
        if public.sps_shared_portal_rating_allowed(prior_item,item) then
          history := history || jsonb_build_array(item);
        else
          history := history || jsonb_build_array(prior_item);
        end if;
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
  -- A stale roster cannot remove a compact-created identity, even before its
  -- first stop, or a client that the saved schedule still uses.
  -- Keep the existing accepted-report protection as an independent condition.
  -- Unregistered and unreferenced clients without accepted reports retain
  -- existing deletion behavior. Registered clients require a future explicit
  -- authorized deletion path; omission alone is not proof of deletion intent.
  for prior in select value from jsonb_array_elements(old_clients) loop
    if not coalesce(incoming_ids ? (prior->>'id'),false)
      and (coalesce(registered_ids ? (prior->>'id'),false)
        or coalesce(scheduled_ids ? (prior->>'id'),false)
        or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(prior->'history')='array' then prior->'history' else '[]'::jsonb end) h
        where nullif(h->>'completionReceiptId','') is not null
          and not (coalesce(target=h->>'completionReceiptId',false) and mode='reverse')
          and not exists (select 1 from public.sps_stop_report_reversals r where r.receipt_id=h->>'completionReceiptId'))) then
      return next prior;
    end if;
  end loop;
  return;
end $f$;

create function public.sps_guard_shared_state_base() returns trigger
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare old_value jsonb; actor text;
begin
  if tg_op='DELETE' then
    if old.key in ('sps_clients','sps_schedule') then raise exception 'shared_state_requires_base_aware_save:%',old.key using errcode='P0S01'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.key<>new.key and (old.key in ('sps_clients','sps_schedule') or new.key in ('sps_clients','sps_schedule')) then
    raise exception 'shared_state_key_immutable' using errcode='42501';
  end if;
  if new.key not in ('sps_clients','sps_schedule') then return new; end if;
  old_value:=case when tg_op='UPDATE' then old.value else '[]'::jsonb end;
  if public.sps_shared_state_trusted(new.key) then return new; end if;
  if exists(select 1 from public.sps_shared_state_unsafe(new.key,old_value,new.value)) then
    raise exception 'shared_state_requires_base_aware_save:%',new.key using errcode='P0S01';
  end if;
  return new;
end $f$;
create trigger sps_base_guard_shared_state before insert or update or delete on public.app_state
for each row execute function public.sps_guard_shared_state_base();

-- The original routines retain every existing authorization and version rule.
-- Catch outside their subtransaction so a held batch changes no other row, yet
-- its compact proposal survives for recovery and the old app keeps pending work.
alter function public.sps_app_state_cas(text,bigint,jsonb) rename to sps_app_state_cas_before_base_guard;
alter function public.sps_app_state_batch_cas(jsonb) rename to sps_app_state_batch_cas_before_base_guard;
create function public.sps_app_state_cas(p_key text,p_expected_version bigint,p_value jsonb)
returns table(applied boolean,outcome text,current_version bigint,changed_at timestamptz)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare result record; saved public.app_state%rowtype;
begin
  begin
    select * into result from public.sps_app_state_cas_before_base_guard(p_key,p_expected_version,p_value);
    return query select result.applied,result.outcome,result.current_version,result.changed_at; return;
  exception when sqlstate 'P0S01' then null;
  end;
  select * into saved from public.app_state where key=p_key for update;
  if found then perform public.sps_shared_state_journal(p_key,saved.value,p_value,saved.version,auth.uid()::text); end if;
  return query select false,'requires-base-aware-save'::text,saved.version,saved.updated_at;
end $f$;
create function public.sps_app_state_batch_cas(p_operations jsonb)
returns table(applied boolean,outcome text,conflict_key text,current_versions jsonb)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare result record; op jsonb; saved public.app_state%rowtype; blocked text; versions jsonb;
begin
  begin
    select * into result from public.sps_app_state_batch_cas_before_base_guard(p_operations);
    return query select result.applied,result.outcome,result.conflict_key,result.current_versions; return;
  exception when sqlstate 'P0S01' then blocked:=split_part(sqlerrm,':',2);
  end;
  perform a.key from public.app_state a where a.key in(select e->>'key' from jsonb_array_elements(p_operations) e) order by a.key for update;
  for op in select value from jsonb_array_elements(p_operations) where value->>'key' in ('sps_clients','sps_schedule') and value ? 'value' loop
    select * into saved from public.app_state where key=op->>'key';
    if found then perform public.sps_shared_state_journal(saved.key,saved.value,op->'value',saved.version,auth.uid()::text); end if;
  end loop;
  select coalesce(jsonb_object_agg(e->>'key',coalesce(a.version,0)),'{}') into versions from jsonb_array_elements(p_operations) e
    left join public.app_state a on a.key=e->>'key';
  return query select false,'requires-base-aware-save'::text,blocked,versions;
end $f$;

create function public.sps_shared_state_patch_batch_cas(p_operations jsonb,p_expected_current jsonb,p_actor_id text)
returns table(applied boolean,outcome text,conflict_key text,current_versions jsonb,"values" jsonb)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare op jsonb; saved public.app_state%rowtype; scope jsonb:='{}'; before_map jsonb:='{}'; result record; previous_context text; entry record; prior_ids jsonb; saved_ids jsonb;
begin
  if current_setting('role',true) is distinct from 'service_role' or coalesce(auth.role(),'')<>'service_role' then raise exception 'shared_state_service_only' using errcode='42501'; end if;
  if jsonb_typeof(p_operations) is distinct from 'array' or jsonb_array_length(p_operations) not between 1 and 256
    or jsonb_typeof(p_expected_current) is distinct from 'object' or nullif(btrim(p_actor_id),'') is null then
    raise exception 'shared_state_patch_input_invalid' using errcode='22023'; end if;
  perform a.key from public.app_state a where a.key in(select e->>'key' from jsonb_array_elements(p_operations) e) order by a.key for update;
  for op in select value from jsonb_array_elements(p_operations) loop
    if op->>'key' not in ('sps_clients','sps_schedule') or not op ? 'value' then continue; end if;
    select * into saved from public.app_state where key=op->>'key';
    if not found or saved.version is distinct from (op->>'expected_version')::bigint or not p_expected_current ? saved.key
      or public.sps_shared_state_decode(saved.value) is distinct from public.sps_shared_state_decode(p_expected_current->saved.key) then
      select coalesce(jsonb_object_agg(a.key,a.version),'{}'),coalesce(jsonb_object_agg(a.key,a.value),'{}') into current_versions,"values"
        from public.app_state a where a.key in(select e->>'key' from jsonb_array_elements(p_operations) e);
      applied:=false; outcome:='conflict'; conflict_key:=op->>'key'; return next; return;
    end if;
    -- Validate proposed identity shape before it can bypass the legacy guard.
    perform * from public.sps_shared_state_entities(saved.key,op->'value');
    select coalesce(jsonb_object_agg(e.entity_id,true),'{}') into prior_ids from public.sps_shared_state_entities(saved.key,saved.value) e;
    if exists(select 1 from public.sps_shared_state_entities(saved.key,op->'value') n
      join public.sps_shared_identity_tombstones t on t.state_key=saved.key and t.entity_id=n.entity_id
      where not prior_ids ? n.entity_id) then raise exception 'shared_deleted_identity_reused' using errcode='40001'; end if;
    scope:=jsonb_set(scope,array[saved.key],'true'::jsonb); before_map:=jsonb_set(before_map,array[saved.key],saved.value);
  end loop;
  if scope='{}'::jsonb or exists(select 1 from jsonb_object_keys(p_expected_current) k where not scope ? k) then
    raise exception 'shared_state_patch_scope_invalid' using errcode='22023'; end if;
  previous_context:=current_setting('sps.shared_state_write',true);
  perform set_config('sps.shared_state_write',jsonb_build_object('keys',scope,'actor',p_actor_id)::text,true);
  begin
    select * into result from public.sps_app_state_batch_cas_before_base_guard(p_operations);
  exception when others then
    perform set_config('sps.shared_state_write',coalesce(previous_context,''),true); raise;
  end;
  perform set_config('sps.shared_state_write',coalesce(previous_context,''),true);
  if result.applied then
    -- A different section's authority trigger may reject a destructive change.
    -- Verify the entire atomic write before allowing related backlinks/alerts
    -- to commit. Check-only fences never request a new value.
    for op in select value from jsonb_array_elements(p_operations) where value ? 'value' loop
      select * into saved from public.app_state where key=op->>'key';
      if not found or public.sps_shared_state_json_content(saved.value) is distinct from public.sps_shared_state_json_content(op->'value') then
        raise exception 'shared_state_protected_change_rejected' using errcode='40001';
      end if;
    end loop;
    for entry in select key,value from jsonb_each(before_map) loop
      select * into saved from public.app_state where key=entry.key;
      select e into op from jsonb_array_elements(p_operations) e where e->>'key'=entry.key;
      if public.sps_shared_state_decode(saved.value) is distinct from public.sps_shared_state_decode(op->'value') then
        raise exception 'shared_state_protected_change_rejected' using errcode='40001';
      end if;
      select coalesce(jsonb_object_agg(e.entity_id,true),'{}') into saved_ids from public.sps_shared_state_entities(entry.key,saved.value) e;
      insert into public.sps_shared_identity_tombstones(state_key,entity_id,actor_id)
        select entry.key,b.entity_id,p_actor_id from public.sps_shared_state_entities(entry.key,entry.value) b
        where (b.entity_id like 'client:%' or b.entity_id like 'stop:%') and not saved_ids ? b.entity_id
        on conflict(state_key,entity_id) do update set deleted_at=clock_timestamp(),actor_id=excluded.actor_id;
    end loop;
  end if;
  select coalesce(jsonb_object_agg(a.key,a.value),'{}') into "values" from public.app_state a where a.key in(select e->>'key' from jsonb_array_elements(p_operations) e);
  applied:=result.applied; outcome:=result.outcome; conflict_key:=result.conflict_key; current_versions:=result.current_versions; return next;
end $f$;

create function public.sps_shared_state_patch_cas(p_key text,p_expected_version bigint,p_expected_current jsonb,p_proposed jsonb,p_actor_id text)
returns table(applied boolean,outcome text,current_version bigint,changed_at timestamptz,value jsonb)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare result record; saved public.app_state%rowtype;
begin
  if p_key not in ('sps_clients','sps_schedule') then raise exception 'shared_state_key_not_allowed' using errcode='22023'; end if;
  select * into result from public.sps_shared_state_patch_batch_cas(jsonb_build_array(jsonb_build_object(
    'key',p_key,'expected_version',p_expected_version,'value',p_proposed)),jsonb_build_object(p_key,p_expected_current),p_actor_id);
  select * into saved from public.app_state where key=p_key;
  return query select result.applied,result.outcome,saved.version,saved.updated_at,saved.value;
end $f$;

create function public.sps_shared_write_candidates_read(p_key text,p_limit integer default 100)
returns setof public.sps_shared_write_candidates
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
begin
  if current_setting('role',true) is distinct from 'service_role' or coalesce(auth.role(),'')<>'service_role' then raise exception 'shared_state_service_only' using errcode='42501'; end if;
  if p_key not in ('sps_clients','sps_schedule') then raise exception 'shared_state_key_not_allowed' using errcode='22023'; end if;
  return query select * from public.sps_shared_write_candidates c where c.state_key=p_key and c.resolved_at is null order by c.id desc limit least(250,greatest(1,p_limit));
end $f$;

-- The existing maintenance-billing RPC constructs its exact client delta under
-- version fences. Scope that trusted operation without opening generic writes.
alter function public.sps_client_maintenance_billing_cas(text,bigint,bigint,jsonb,jsonb) rename to sps_client_maintenance_billing_cas_before_base_guard;
create function public.sps_client_maintenance_billing_cas(p_client_id text,p_expected_clients_version bigint,p_expected_billing_version bigint,p_maintenance_billing jsonb,p_ledger jsonb)
returns table(applied boolean,outcome text,conflict_key text,current_versions jsonb,client jsonb)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare previous_context text; result record;
begin
  if current_setting('role',true) is distinct from 'service_role' or coalesce(auth.role(),'')<>'service_role' then raise exception 'shared_state_service_only' using errcode='42501'; end if;
  previous_context:=current_setting('sps.shared_state_write',true);
  perform set_config('sps.shared_state_write','{"keys":{"sps_clients":true}}',true);
  begin
    select * into result from public.sps_client_maintenance_billing_cas_before_base_guard(p_client_id,p_expected_clients_version,p_expected_billing_version,p_maintenance_billing,p_ledger);
  exception when others then
    perform set_config('sps.shared_state_write',coalesce(previous_context,''),true); raise;
  end;
  perform set_config('sps.shared_state_write',coalesce(previous_context,''),true);
  return query select result.applied,result.outcome,result.conflict_key,result.current_versions,result.client;
end $f$;

do $grants$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and (p.proname like 'sps_shared_%' or p.proname in ('sps_guard_shared_state_base','sps_app_state_cas','sps_app_state_batch_cas',
      'sps_app_state_cas_before_base_guard','sps_app_state_batch_cas_before_base_guard','sps_client_maintenance_billing_cas','sps_client_maintenance_billing_cas_before_base_guard')) loop
    execute format('alter function %s owner to postgres',f.signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end $grants$;
grant execute on function public.sps_app_state_cas(text,bigint,jsonb),public.sps_app_state_batch_cas(jsonb) to authenticated,service_role;
grant execute on function public.sps_shared_state_patch_cas(text,bigint,jsonb,jsonb,text),public.sps_shared_state_patch_batch_cas(jsonb,jsonb,text),
  public.sps_shared_write_candidates_read(text,integer),public.sps_client_maintenance_billing_cas(text,bigint,bigint,jsonb,jsonb) to service_role;
commit;
