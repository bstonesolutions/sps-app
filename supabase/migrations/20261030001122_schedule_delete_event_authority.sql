-- A snapshot diff is not evidence that someone chose Delete. Keep schedule
-- removals behind an explicit event scope, including for installed older apps.
begin;

create table public.sps_schedule_deletion_receipts (
  operation_id text not null check(length(operation_id) between 1 and 320),
  stop_id text not null,
  actor_id text not null,
  before_version bigint not null,
  stop_snapshot jsonb not null check(jsonb_typeof(stop_snapshot)='object'),
  deleted_at timestamptz not null default clock_timestamp(),
  primary key(operation_id,stop_id)
);
alter table public.sps_schedule_deletion_receipts enable row level security;
revoke all on public.sps_schedule_deletion_receipts from public,anon,authenticated,service_role;

-- This trigger writes only the private recovery receipt, so it needs its
-- owner's table privilege. Browser-provided GUCs cannot authorize removal.
create function public.sps_guard_schedule_delete_event() returns trigger
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare old_map jsonb; new_ids jsonb; removed jsonb; scope jsonb; item record;
begin
  if old.key<>'sps_schedule' or new.key<>'sps_schedule' or old.value=new.value then return new; end if;
  select coalesce(jsonb_object_agg(e.entity_id,e.body),'{}') into old_map
    from public.sps_shared_state_entities('sps_schedule',old.value) e where e.entity_id like 'stop:%';
  select coalesce(jsonb_object_agg(e.entity_id,true),'{}') into new_ids
    from public.sps_shared_state_entities('sps_schedule',new.value) e where e.entity_id like 'stop:%';
  select coalesce(jsonb_agg(substr(e.key,6) order by e.key),'[]') into removed
    from jsonb_each(old_map) e where not new_ids ? e.key;
  if removed='[]'::jsonb then return new; end if;
  -- Existing administrative recovery/migration sessions retain their privilege;
  -- SECURITY DEFINER application calls still carry role=service_role here.
  if session_user='postgres' and coalesce(current_setting('role',true),'none') in ('none','') then return new; end if;
  scope:=coalesce(nullif(current_setting('sps.schedule_delete_event',true),'')::jsonb,'{}');
  if current_setting('role',true) is distinct from 'service_role' or coalesce(auth.role(),'')<>'service_role'
    or scope->'stop_ids' is distinct from removed or nullif(btrim(scope->>'actor'),'') is null
    or nullif(btrim(scope->>'operation_id'),'') is null or length(scope->>'operation_id')>320 then
    raise exception 'shared_schedule_delete_requires_action' using errcode='PT409';
  end if;
  for item in select e.key,e.value from jsonb_each(old_map) e where not new_ids ? e.key loop
    insert into public.sps_schedule_deletion_receipts(operation_id,stop_id,actor_id,before_version,stop_snapshot)
      values(scope->>'operation_id',substr(item.key,6),scope->>'actor',old.version,item.value);
  end loop;
  return new;
end $f$;
revoke all on function public.sps_guard_schedule_delete_event() from public,anon,authenticated,service_role;
create trigger sps_explicit_schedule_delete_event before update on public.app_state
for each row execute function public.sps_guard_schedule_delete_event();

-- Only the authenticated server Delete handler supplies this event scope. The
-- nested CAS still checks exact current values/versions under sorted row locks.
create function public.sps_schedule_delete_patch_batch_cas(p_operations jsonb,p_expected_current jsonb,p_stop_ids jsonb,p_actor_id text,p_operation_id text)
returns table(applied boolean,outcome text,conflict_key text,current_versions jsonb,"values" jsonb)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare op jsonb; old_ids jsonb; new_ids jsonb; removed jsonb; requested jsonb; previous_scope text; result record;
begin
  if current_setting('role',true) is distinct from 'service_role' or coalesce(auth.role(),'')<>'service_role' then
    raise exception 'shared_state_service_only' using errcode='42501'; end if;
  if jsonb_typeof(p_operations) is distinct from 'array' or jsonb_typeof(p_expected_current) is distinct from 'object'
    or jsonb_typeof(p_stop_ids) is distinct from 'array' or jsonb_array_length(p_stop_ids) not between 1 and 5000
    or nullif(btrim(p_actor_id),'') is null or nullif(btrim(p_operation_id),'') is null or length(p_operation_id)>320
    or exists(select 1 from jsonb_array_elements(p_stop_ids) v where jsonb_typeof(v)<>'string' or nullif(btrim(v#>>'{}'),'') is null or length(v#>>'{}')>320)
    or (select count(distinct v) from jsonb_array_elements(p_stop_ids) v)<>jsonb_array_length(p_stop_ids)
    or (select count(*) from jsonb_array_elements(p_operations) e where e->>'key'='sps_schedule' and e ? 'value')<>1
    or not p_expected_current ? 'sps_schedule' then
    raise exception 'shared_schedule_delete_scope_invalid' using errcode='22023'; end if;
  select e into op from jsonb_array_elements(p_operations) e where e->>'key'='sps_schedule';
  select coalesce(jsonb_object_agg(e.entity_id,true),'{}') into old_ids from public.sps_shared_state_entities('sps_schedule',p_expected_current->'sps_schedule') e where e.entity_id like 'stop:%';
  select coalesce(jsonb_object_agg(e.entity_id,true),'{}') into new_ids from public.sps_shared_state_entities('sps_schedule',op->'value') e where e.entity_id like 'stop:%';
  select coalesce(jsonb_agg(substr(e.key,6) order by e.key),'[]') into removed from jsonb_each(old_ids) e where not new_ids ? e.key;
  select jsonb_agg(v order by v) into requested from jsonb_array_elements(p_stop_ids) v;
  if removed is distinct from requested then raise exception 'shared_schedule_delete_scope_invalid' using errcode='22023'; end if;
  if exists(select 1 from public.sps_schedule_deletion_receipts r where r.operation_id=p_operation_id) then
    raise exception 'shared_schedule_delete_operation_reused' using errcode='PT409'; end if;
  previous_scope:=current_setting('sps.schedule_delete_event',true);
  perform set_config('sps.schedule_delete_event',jsonb_build_object('stop_ids',requested,'actor',p_actor_id,'operation_id',p_operation_id)::text,true);
  begin
    select * into result from public.sps_shared_state_patch_batch_cas(p_operations,p_expected_current,p_actor_id);
  exception when others then
    perform set_config('sps.schedule_delete_event',coalesce(previous_scope,''),true); raise;
  end;
  perform set_config('sps.schedule_delete_event',coalesce(previous_scope,''),true);
  applied:=result.applied;outcome:=result.outcome;conflict_key:=result.conflict_key;current_versions:=result.current_versions;"values":=result."values";return next;
end $f$;
revoke all on function public.sps_schedule_delete_patch_batch_cas(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.sps_schedule_delete_patch_batch_cas(jsonb,jsonb,jsonb,text,text) to service_role;

commit;
