-- Reject stale/protected proposals before row locks and avoid repeated entity scans.
begin;

create or replace function public.sps_shared_state_patch_batch_cas(p_operations jsonb,p_expected_current jsonb,p_actor_id text)
returns table(applied boolean,outcome text,conflict_key text,current_versions jsonb,"values" jsonb)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare op jsonb; saved public.app_state%rowtype; scope jsonb:='{}'; before_map jsonb:='{}'; result record; previous_context text; entry record; prior_ids jsonb; saved_ids jsonb; after_ids jsonb:='{}'; before_value jsonb; proposed_value jsonb; guard_value jsonb; stop_context jsonb;
begin
  if current_setting('role',true) is distinct from 'service_role' or coalesce(auth.role(),'')<>'service_role' then raise exception 'shared_state_service_only' using errcode='42501'; end if;
  if jsonb_typeof(p_operations) is distinct from 'array' or jsonb_array_length(p_operations) not between 1 and 256
    or jsonb_typeof(p_expected_current) is distinct from 'object' or nullif(btrim(p_actor_id),'') is null then
    raise exception 'shared_state_patch_input_invalid' using errcode='22023'; end if;
  -- Read and validate before acquiring any row lock. The nested batch CAS
  -- rechecks every version under its sorted locks before writing. A stale or
  -- protected snapshot therefore cannot queue behind, or block, valid writes.
  for op in select value from jsonb_array_elements(p_operations) loop
    if op->>'key' not in ('sps_clients','sps_schedule') or not op ? 'value' then continue; end if;
    select * into saved from public.app_state where key=op->>'key';
    if not found or saved.version is distinct from (op->>'expected_version')::bigint or not p_expected_current ? saved.key then
      select coalesce(jsonb_object_agg(a.key,a.version),'{}'),coalesce(jsonb_object_agg(a.key,a.value),'{}') into current_versions,"values"
        from public.app_state a where a.key in(select e->>'key' from jsonb_array_elements(p_operations) e);
      applied:=false; outcome:='conflict'; conflict_key:=op->>'key'; return next; return;
    end if;
    before_value:=public.sps_shared_state_decode(saved.value);
    if before_value is distinct from public.sps_shared_state_decode(p_expected_current->saved.key) then
      select coalesce(jsonb_object_agg(a.key,a.version),'{}'),coalesce(jsonb_object_agg(a.key,a.value),'{}') into current_versions,"values"
        from public.app_state a where a.key in(select e->>'key' from jsonb_array_elements(p_operations) e);
      applied:=false; outcome:='conflict'; conflict_key:=op->>'key'; return next; return;
    end if;
    -- Validate proposed identity shape before it can bypass the legacy guard.
    proposed_value:=public.sps_shared_state_decode(op->'value');
    select coalesce(jsonb_object_agg(e.entity_id,true),'{}') into saved_ids from public.sps_shared_state_entities(saved.key,proposed_value) e;
    select coalesce(jsonb_object_agg(e.entity_id,true),'{}') into prior_ids from public.sps_shared_state_entities(saved.key,before_value) e;
    if exists(select 1 from jsonb_object_keys(saved_ids) n(entity_id)
      join public.sps_shared_identity_tombstones t on t.state_key=saved.key and t.entity_id=n.entity_id
      where not prior_ids ? n.entity_id) then raise exception 'shared_deleted_identity_reused' using errcode='40001'; end if;
    scope:=jsonb_set(scope,array[saved.key],'true'::jsonb);
    before_map:=jsonb_set(before_map,array[saved.key],prior_ids); after_ids:=jsonb_set(after_ids,array[saved.key],saved_ids);
  end loop;
  if scope='{}'::jsonb or exists(select 1 from jsonb_object_keys(p_expected_current) k where not scope ? k) then
    raise exception 'shared_state_patch_scope_invalid' using errcode='22023'; end if;
  previous_context:=current_setting('sps.shared_state_write',true);
  perform set_config('sps.shared_state_write',jsonb_build_object('keys',scope,'actor',p_actor_id)::text,true);
  begin
    if scope ? 'sps_clients' and coalesce((select enabled from public.sps_stop_report_guard_config where singleton),false) then
      -- Run the same accepted-report and scheduled-client guard as the trigger.
      -- Its read-only projection rejects protected replacements before any
      -- UPDATE/row lock; the trigger still runs after locked version validation.
      select public.sps_shared_state_decode(e->'value') into proposed_value from jsonb_array_elements(p_operations) e where e->>'key'='sps_clients';
      before_value:=public.sps_shared_state_decode(p_expected_current->'sps_clients');
      stop_context:=coalesce(nullif(current_setting('sps.stop_report_write',true),'')::jsonb,'{}');
      guard_value:=public.sps_stop_guard_clients(before_value,proposed_value,stop_context);
      if guard_value is distinct from proposed_value then
        raise exception 'shared_state_protected_change_rejected' using errcode='40001';
      end if;
    end if;
    before_value:=null; proposed_value:=null; guard_value:=null;
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
      saved_ids:=after_ids->entry.key;
      insert into public.sps_shared_identity_tombstones(state_key,entity_id,actor_id)
        select entry.key,b.entity_id,p_actor_id from jsonb_object_keys(entry.value) b(entity_id)
        where (b.entity_id like 'client:%' or b.entity_id like 'stop:%') and not saved_ids ? b.entity_id
        on conflict(state_key,entity_id) do update set deleted_at=clock_timestamp(),actor_id=excluded.actor_id;
    end loop;
  end if;
  select coalesce(jsonb_object_agg(a.key,a.value),'{}') into "values" from public.app_state a where a.key in(select e->>'key' from jsonb_array_elements(p_operations) e);
  applied:=result.applied; outcome:=result.outcome; conflict_key:=result.conflict_key; current_versions:=result.current_versions; return next;
end $f$;

commit;
