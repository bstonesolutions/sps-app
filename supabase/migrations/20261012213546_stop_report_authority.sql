-- Install first, deploy the stop/edit API using the restricted RPC, then activate.
-- Activation is explicit so the currently deployed generic-CAS endpoint keeps working.
-- Protects receipt-backed reports; receipt-less legacy history remains legacy data.
begin;

create table if not exists public.sps_stop_report_guard_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  activated_at timestamptz
);
insert into public.sps_stop_report_guard_config (singleton) values (true)
on conflict (singleton) do nothing;
create table if not exists public.sps_stop_report_guard_backups (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default clock_timestamp(),
  reason text not null,
  rows jsonb not null
);
create table if not exists public.sps_stop_report_reversals (
  sid text not null,
  receipt_id text not null,
  reversed_at timestamptz not null default clock_timestamp(),
  report jsonb,
  marker jsonb not null,
  receipt jsonb,
  primary key (sid, receipt_id)
);
create index if not exists sps_stop_report_reversals_receipt on public.sps_stop_report_reversals(receipt_id);
alter table public.sps_stop_report_guard_config enable row level security;
alter table public.sps_stop_report_guard_backups enable row level security;
alter table public.sps_stop_report_reversals enable row level security;
revoke all on public.sps_stop_report_guard_config, public.sps_stop_report_guard_backups,
  public.sps_stop_report_reversals from public, anon, authenticated, service_role;
revoke all on sequence public.sps_stop_report_guard_backups_id_seq from public,anon,authenticated,service_role;

insert into public.sps_stop_report_guard_backups (reason, rows)
select 'installation', coalesce(jsonb_agg(to_jsonb(a) order by a.key), '[]'::jsonb)
from public.app_state a where a.key in ('sps_clients','sps_completed','sps_schedule','sps_catalog');

-- app_state historically contains both JSON values and one/two JSON.stringify layers.
create or replace function public.sps_stop_state_decode(p_value jsonb)
returns jsonb language plpgsql immutable set search_path = pg_catalog as $f$
declare v jsonb := p_value; i integer;
begin
  for i in 1..2 loop
    exit when jsonb_typeof(v) is distinct from 'string';
    v := (v #>> '{}')::jsonb;
  end loop;
  if jsonb_typeof(v) = 'string' then raise exception 'stop_state_encoding_invalid' using errcode='22023'; end if;
  return v;
end $f$;
create or replace function public.sps_stop_state_encode(p_value jsonb, p_template jsonb)
returns jsonb language plpgsql immutable set search_path = pg_catalog as $f$
declare v jsonb := p_template; result jsonb := p_value; depth integer := 0; i integer;
begin
  while jsonb_typeof(v) = 'string' and depth < 2 loop
    depth := depth + 1; v := (v #>> '{}')::jsonb;
  end loop;
  for i in 1..depth loop result := to_jsonb(result::text); end loop;
  return result;
end $f$;

-- One row's locked OLD value is the preservation source. No cross-row snapshot reads.
create or replace function public.sps_stop_guard_client_items(p_old jsonb, p_new jsonb, p_context jsonb)
returns setof jsonb language plpgsql security definer set search_path = pg_catalog as $f$
declare
  incoming jsonb; prior jsonb; item jsonb; prior_item jsonb; old_by_id jsonb; incoming_ids jsonb;
  history jsonb; old_history jsonb; client_id text; rid text; target text := p_context->>'receipt';
  mode text := p_context->>'mode'; old_clients jsonb := coalesce(p_old, '[]');
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
  for incoming in select value from jsonb_array_elements(p_new) loop
    client_id := incoming->>'id';
    prior := old_by_id->client_id;
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
  -- Removing an entire client is also a report deletion; keep that saved client intact.
  for prior in select value from jsonb_array_elements(old_clients) loop
    if not coalesce(incoming_ids ? (prior->>'id'),false)
      and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(prior->'history')='array' then prior->'history' else '[]'::jsonb end) h
        where nullif(h->>'completionReceiptId','') is not null
          and not (coalesce(target=h->>'completionReceiptId',false) and mode='reverse')
          and not exists (select 1 from public.sps_stop_report_reversals r where r.receipt_id=h->>'completionReceiptId')) then
      return next prior;
    end if;
  end loop;
  return;
end $f$;
create or replace function public.sps_stop_guard_clients(p_old jsonb, p_new jsonb, p_context jsonb)
returns jsonb language sql security definer set search_path = pg_catalog as $f$
  select coalesce(jsonb_agg(item),'[]'::jsonb)
  from public.sps_stop_guard_client_items(p_old,p_new,p_context) item;
$f$;

create or replace function public.sps_stop_guard_completed(p_old jsonb, p_new jsonb, p_context jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $f$
declare
  prior jsonb := coalesce(p_old,'{}'); result jsonb := p_new; item record;
  ledger jsonb := '{}'; old_ledger jsonb; incoming_ledger jsonb; reversals jsonb;
  target text := p_context->>'receipt'; sid text := p_context->>'sid'; mode text := p_context->>'mode'; rid text;
begin
  if jsonb_typeof(prior)<>'object' or jsonb_typeof(result)<>'object' then
    raise exception 'stop_completed_shape_invalid' using errcode='22023';
  end if;
  old_ledger := case when jsonb_typeof(prior->'__stopReversalReceipts')='object' then prior->'__stopReversalReceipts' else '{}'::jsonb end;
  incoming_ledger := case when jsonb_typeof(result->'__stopReversalReceipts')='object' then result->'__stopReversalReceipts' else '{}'::jsonb end;
  reversals := case when jsonb_typeof(prior->'__stopReversedRequests')='object' then prior->'__stopReversedRequests' else '{}'::jsonb end;
  if mode='reverse' and nullif(target,'') is not null then
    reversals := jsonb_set(reversals,array[target],p_new->'__stopReversedRequests'->target);
  end if;
  for item in select * from jsonb_each(result - '__stopReversalReceipts' - '__stopReversedRequests') loop
    rid := nullif(item.value->>'receiptId','');
    if (rid is not null and not (coalesce(item.key=sid and rid=target,false) and mode='complete'))
      or (item.value='true'::jsonb and exists (select 1 from public.sps_stop_report_reversals r where r.sid=item.key)) then
      result := result - item.key;
    end if;
  end loop;
  for item in select * from jsonb_each(prior - '__stopReversalReceipts' - '__stopReversedRequests') loop
    rid := nullif(item.value->>'receiptId','');
    if rid is null or (coalesce(item.key=sid and rid=target,false) and mode='reverse') then continue; end if;
    if exists (select 1 from public.sps_stop_report_reversals r where r.receipt_id=rid) then continue; end if;
    result := jsonb_set(result,array[item.key],item.value);
  end loop;
  for item in select * from jsonb_each(old_ledger) loop
    if (coalesce(item.key=target,false) and mode='reverse')
      or exists (select 1 from public.sps_stop_report_reversals r where r.receipt_id=item.key) then continue; end if;
    if mode='reverse' then
      -- Reversing an older balance receipt can compact a later receipt's prior
      -- balance chain. Its inventory/history/identity must remain unchanged.
      if incoming_ledger ? item.key then
        if (incoming_ledger->item.key #- '{balance,before}') is distinct from (item.value #- '{balance,before}') then
          raise exception 'stop_reverse_changed_unrelated_receipt' using errcode='22023';
        end if;
        ledger := jsonb_set(ledger,array[item.key],incoming_ledger->item.key);
      elsif exists (select 1 from jsonb_each(prior - '__stopReversalReceipts' - '__stopReversedRequests') m
        where m.key<>sid and m.value->>'receiptId'=item.key) then
        raise exception 'stop_reverse_removed_active_receipt' using errcode='22023';
      end if;
    else ledger := jsonb_set(ledger,array[item.key],item.value); end if;
  end loop;
  if mode='reverse' and exists (select 1 from jsonb_each(incoming_ledger) e where not old_ledger ? e.key) then
    raise exception 'stop_reverse_added_unrelated_receipt' using errcode='22023';
  end if;
  if mode='complete' and target is not null then ledger := jsonb_set(ledger,array[target],incoming_ledger->target); end if;
  result := result - '__stopReversalReceipts' - '__stopReversedRequests';
  if ledger<>'{}'::jsonb then result := jsonb_set(result,'{__stopReversalReceipts}',ledger); end if;
  if reversals<>'{}'::jsonb then result := jsonb_set(result,'{__stopReversedRequests}',reversals); end if;
  return result;
end $f$;

create or replace function public.sps_guard_accepted_stop_reports()
returns trigger language plpgsql security definer set search_path = pg_catalog as $f$
declare old_value jsonb; incoming_value jsonb; value jsonb; context jsonb := '{}'; raw_context text;
begin
  if not coalesce((select enabled from public.sps_stop_report_guard_config where singleton),false) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then
    if old.key in ('sps_clients','sps_completed') then
      raise exception 'accepted_stop_reports_require_server_mutation' using errcode='42501';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.key<>new.key and (old.key in ('sps_clients','sps_completed') or new.key in ('sps_clients','sps_completed')) then
    raise exception 'accepted_stop_report_key_is_immutable' using errcode='42501';
  end if;
  if new.key not in ('sps_clients','sps_completed') then return new; end if;
  if coalesce(auth.role(),'')='service_role' then
    raw_context := current_setting('sps.stop_report_write',true);
    if nullif(raw_context,'') is not null then context := raw_context::jsonb; end if;
  end if;
  old_value := case when tg_op='UPDATE' then public.sps_stop_state_decode(old.value) else null end;
  incoming_value := public.sps_stop_state_decode(new.value); value := incoming_value;
  if new.key='sps_clients' then value := public.sps_stop_guard_clients(old_value,value,context);
  else value := public.sps_stop_guard_completed(old_value,value,context); end if;
  -- Keep the caller's exact string bytes when no report protection changed data.
  -- Older client save fences compare serialized strings, including key order.
  if value is distinct from incoming_value then new.value := public.sps_stop_state_encode(value,new.value); end if;
  return new;
end $f$;
drop trigger if exists sps_guard_accepted_stop_reports on public.app_state;
create trigger sps_guard_accepted_stop_reports before insert or update or delete on public.app_state
for each row execute function public.sps_guard_accepted_stop_reports();

create or replace function public.sps_stop_completion_batch_cas(
  p_operations jsonb, p_mode text, p_sid text, p_receipt_id text
) returns table (applied boolean, outcome text, conflict_key text, current_versions jsonb)
language plpgsql security definer set search_path = pg_catalog set row_security = off as $f$
declare
  op jsonb; k text; current_version bigint; versions jsonb := '{}'; conflict text;
  old_clients jsonb; new_clients jsonb; old_completed jsonb; new_completed jsonb;
  old_marker jsonb; new_marker jsonb; verified_receipt jsonb; saved_report jsonb; new_report jsonb;
  client_id text; report_count integer; old_report_count integer; old_context text := current_setting('sps.stop_report_write',true);
  result record; reversal jsonb; expected_clients jsonb; old_history jsonb; ci integer; hi integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'stop_mutation_service_only' using errcode='42501'; end if;
  if p_mode not in ('complete','reverse','edit') or p_mode is null or nullif(btrim(p_sid),'') is null
    or length(p_sid)>320 or p_sid in ('__stopReversalReceipts','__stopReversedRequests')
    or p_receipt_id is null or length(p_receipt_id)>320
    or (p_mode<>'reverse' and nullif(btrim(p_receipt_id),'') is null) then
    raise exception 'stop_mutation_identity_invalid' using errcode='22023';
  end if;
  if jsonb_typeof(p_operations) is distinct from 'array' or jsonb_array_length(p_operations)<2
    or jsonb_array_length(p_operations)>8 then raise exception 'stop_mutation_operations_invalid' using errcode='22023'; end if;
  if (select count(distinct e->>'key') from jsonb_array_elements(p_operations) e)<>jsonb_array_length(p_operations) then
    raise exception 'stop_mutation_duplicate_key' using errcode='22023';
  end if;
  for op in select value from jsonb_array_elements(p_operations) loop
    k := op->>'key';
    if k is null or k not in ('sps_clients','sps_completed','sps_schedule','sps_catalog','sps_billing_reviews','sps_invoices','sps_maintenance_billing')
      or (p_mode='edit' and k not in ('sps_clients','sps_completed'))
      or coalesce(op->>'expected_version','') !~ '^(0|[1-9][0-9]*)$' then
      raise exception 'stop_mutation_operation_not_allowed' using errcode='22023';
    end if;
    if k in ('sps_invoices','sps_maintenance_billing') and coalesce(op->>'check_only','false')<>'true'
      and not (op->>'expected_version'='0' and (
        (k='sps_invoices' and public.sps_stop_state_decode(op->'value')='[]'::jsonb)
        or (k='sps_maintenance_billing' and public.sps_stop_state_decode(op->'value')='{"version":2,"policies":{},"allocations":{}}'::jsonb))) then
      raise exception 'stop_mutation_accounting_write_not_allowed' using errcode='22023';
    end if;
  end loop;
  if not exists (select 1 from jsonb_array_elements(p_operations) e where e->>'key'='sps_clients' and e ? 'value' and coalesce(e->>'check_only','false')='false')
    or not exists (select 1 from jsonb_array_elements(p_operations) e where e->>'key'='sps_completed'
      and case when p_mode='edit' then e->>'check_only'='true' else e ? 'value' and coalesce(e->>'check_only','false')='false' end) then
    raise exception 'stop_mutation_required_rows_missing' using errcode='22023';
  end if;
  -- Match the generic batch lock order. Validate exact transitions only after locks.
  perform a.key from public.app_state a where a.key in (select e->>'key' from jsonb_array_elements(p_operations) e) order by a.key for update;
  for op in select value from jsonb_array_elements(p_operations) order by value->>'key' loop
    k := op->>'key';
    select a.version into current_version from public.app_state a where a.key=k;
    current_version := coalesce(current_version,0);
    versions := jsonb_set(versions,array[k],to_jsonb(current_version));
    if current_version<>(op->>'expected_version')::bigint and conflict is null then conflict := k; end if;
  end loop;
  if conflict is not null then return query select false,'conflict'::text,conflict,versions; return; end if;
  select public.sps_stop_state_decode(a.value) into old_clients from public.app_state a where a.key='sps_clients';
  select public.sps_stop_state_decode(a.value) into old_completed from public.app_state a where a.key='sps_completed';
  old_completed := coalesce(old_completed,'{}');
  select public.sps_stop_state_decode(e->'value') into new_clients from jsonb_array_elements(p_operations) e where e->>'key'='sps_clients';
  select public.sps_stop_state_decode(e->'value') into new_completed from jsonb_array_elements(p_operations) e where e->>'key'='sps_completed';
  if jsonb_typeof(old_clients) is distinct from 'array' or jsonb_typeof(new_clients) is distinct from 'array'
    or jsonb_typeof(old_completed)<>'object' or (p_mode<>'edit' and jsonb_typeof(new_completed) is distinct from 'object') then
    raise exception 'stop_mutation_state_invalid' using errcode='22023';
  end if;
  old_marker := old_completed->p_sid; new_marker := new_completed->p_sid;
  if p_mode='complete' then
    verified_receipt := new_completed->'__stopReversalReceipts'->p_receipt_id;
    if old_marker is not null or new_marker->>'receiptId' is distinct from p_receipt_id
      or new_marker->>'v' is distinct from '2'
      or exists (select 1 from public.sps_stop_report_reversals r where r.receipt_id=p_receipt_id) then
      raise exception 'stop_completion_transition_invalid' using errcode='22023';
    end if;
  else
    verified_receipt := old_completed->'__stopReversalReceipts'->p_receipt_id;
    if p_receipt_id='' then
      if p_mode<>'reverse' or old_marker is distinct from 'true'::jsonb then raise exception 'stop_legacy_reverse_invalid' using errcode='22023'; end if;
    elsif old_marker->>'receiptId' is distinct from p_receipt_id then
      raise exception 'stop_receipt_not_current' using errcode='22023';
    end if;
    if p_mode='reverse' and (new_marker is not null or new_completed->'__stopReversalReceipts' ? p_receipt_id) then
      raise exception 'stop_reversal_transition_invalid' using errcode='22023';
    end if;
  end if;
  if p_receipt_id<>'' then
    if verified_receipt->>'v' is distinct from '1'
      or (case when p_mode='complete' then new_marker else old_marker end)->>'v' is distinct from '2'
      or (case when p_mode='complete' then new_marker else old_marker end)->>'completedAt' is distinct from verified_receipt->>'completedAt'
      or nullif(verified_receipt->>'completedAt','') is null
      or length(coalesce(verified_receipt->>'idempotencyKey',''))<8
      or verified_receipt->>'id' is distinct from p_receipt_id or verified_receipt->>'sid' is distinct from p_sid
      or verified_receipt->'history'->>'entryReceiptId' is distinct from p_receipt_id
      or nullif(verified_receipt->>'clientId','') is null then raise exception 'stop_receipt_identity_invalid' using errcode='22023'; end if;
    client_id := verified_receipt->>'clientId';
    if (select count(*) from jsonb_array_elements(old_clients) c where c->>'id'=client_id)<>1 then
      raise exception 'stop_receipt_client_ambiguous' using errcode='22023';
    end if;
    if p_mode='complete' and exists (select 1 from public.sps_stop_report_reversals r
      where r.sid=p_sid and r.receipt->>'clientId'=client_id
        and r.receipt->>'idempotencyKey'=verified_receipt->>'idempotencyKey') then
      raise exception 'stop_completion_already_reversed' using errcode='22023';
    end if;
    if p_mode='reverse' then
      reversal := new_completed->'__stopReversedRequests'->p_receipt_id;
      if reversal->>'receiptId' is distinct from p_receipt_id or reversal->>'sid' is distinct from p_sid
        or reversal->>'clientId' is distinct from client_id
        or reversal->>'idempotencyKey' is distinct from verified_receipt->>'idempotencyKey'
        or nullif(reversal->>'reversedAt','') is null then
        raise exception 'stop_reversal_tombstone_invalid' using errcode='22023';
      end if;
    end if;
    select count(*), (jsonb_agg(h))->0 into report_count,saved_report
      from jsonb_array_elements(old_clients) c cross join lateral jsonb_array_elements(case when jsonb_typeof(c->'history')='array' then c->'history' else '[]'::jsonb end) h
      where c->>'id'=client_id and h->>'completionReceiptId'=p_receipt_id and h->>'sid'=p_sid;
    old_report_count := report_count;
    if (p_mode='complete' and report_count<>0) or (p_mode='reverse' and report_count<>1)
      or (p_mode='edit' and report_count not in (0,1)) then
      raise exception 'stop_existing_report_identity_invalid' using errcode='22023';
    end if;
    select count(*), (jsonb_agg(h))->0 into report_count,new_report
      from jsonb_array_elements(new_clients) c cross join lateral jsonb_array_elements(case when jsonb_typeof(c->'history')='array' then c->'history' else '[]'::jsonb end) h
      where h->>'completionReceiptId'=p_receipt_id;
    if report_count<>(case when p_mode='reverse' then 0 else 1 end)
      or (p_mode<>'reverse' and (new_report->>'sid' is distinct from p_sid
        or not exists (select 1 from jsonb_array_elements(new_clients) c cross join lateral jsonb_array_elements(case when jsonb_typeof(c->'history')='array' then c->'history' else '[]'::jsonb end) h
          where c->>'id'=client_id and h->>'completionReceiptId'=p_receipt_id))) then
      raise exception 'stop_new_report_identity_invalid' using errcode='22023';
    end if;
  end if;
  if p_mode='edit' then
    if old_report_count=0 then
      select (c.ordinality-1)::integer,case when jsonb_typeof(c.value->'history')='array' then c.value->'history' else '[]'::jsonb end into ci,old_history
        from jsonb_array_elements(old_clients) with ordinality c(value,ordinality) where c.value->>'id'=client_id;
      if exists (select 1 from jsonb_array_elements(old_clients) c cross join lateral jsonb_array_elements(case when jsonb_typeof(c->'history')='array' then c->'history' else '[]'::jsonb end) h
          where h->>'completionReceiptId'=p_receipt_id)
        or exists (select 1 from jsonb_array_elements(old_history) h where h->>'sid'=p_sid)
        or (nullif(btrim(coalesce(new_report->>'notes','')),'') is null
          and coalesce(new_report->'photos','[]')='[]'::jsonb
          and not exists (select 1 from jsonb_each_text(case when jsonb_typeof(new_report->'readings')='object' then new_report->'readings' else '{}'::jsonb end) r where r.value is not null and r.value not in ('','—'))) then
        raise exception 'stop_report_recovery_invalid' using errcode='22023';
      end if;
      expected_clients := jsonb_set(old_clients,array[ci::text,'history'],jsonb_build_array(new_report)||old_history);
    else
      select (c.ordinality-1)::integer,(h.ordinality-1)::integer into ci,hi
      from jsonb_array_elements(old_clients) with ordinality c(value,ordinality)
      cross join lateral jsonb_array_elements(case when jsonb_typeof(c.value->'history')='array' then c.value->'history' else '[]'::jsonb end) with ordinality h(value,ordinality)
      where c.value->>'id'=client_id and h.value->>'completionReceiptId'=p_receipt_id;
      expected_clients := jsonb_set(old_clients,array[ci::text,'history',hi::text],new_report);
    end if;
    if new_clients is distinct from expected_clients then raise exception 'stop_edit_changed_unrelated_data' using errcode='22023'; end if;
  end if;
  perform set_config('sps.stop_report_write',jsonb_build_object('mode',p_mode,'sid',p_sid,'receipt',p_receipt_id)::text,true);
  select * into result from public.sps_app_state_batch_cas(p_operations);
  if result.applied and p_mode='reverse' then
    insert into public.sps_stop_report_reversals(sid,receipt_id,report,marker,receipt)
      values(p_sid,p_receipt_id,saved_report,old_marker,verified_receipt) on conflict (sid,receipt_id) do nothing;
  end if;
  perform set_config('sps.stop_report_write',coalesce(old_context,''),true);
  return query select result.applied,result.outcome,result.conflict_key,result.current_versions;
exception when others then
  perform set_config('sps.stop_report_write',coalesce(old_context,''),true);
  raise;
end $f$;

create or replace function public.sps_activate_stop_report_guard()
returns boolean language plpgsql security definer set search_path = pg_catalog set row_security = off as $f$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'stop_guard_activation_service_only' using errcode='42501'; end if;
  lock table public.app_state in share row exclusive mode;
  if (select enabled from public.sps_stop_report_guard_config where singleton) then return false; end if;
  insert into public.sps_stop_report_guard_backups(reason,rows)
    select 'activation',coalesce(jsonb_agg(to_jsonb(a) order by a.key),'[]'::jsonb)
    from public.app_state a where a.key in ('sps_clients','sps_completed','sps_schedule','sps_catalog');
  update public.sps_stop_report_guard_config set enabled=true,activated_at=clock_timestamp() where singleton;
  return true;
end $f$;

-- Helpers have no public callable surface; both entrypoints require service JWTs too.
alter function public.sps_stop_state_decode(jsonb) owner to postgres;
alter function public.sps_stop_state_encode(jsonb,jsonb) owner to postgres;
alter function public.sps_stop_guard_client_items(jsonb,jsonb,jsonb) owner to postgres;
alter function public.sps_stop_guard_clients(jsonb,jsonb,jsonb) owner to postgres;
alter function public.sps_stop_guard_completed(jsonb,jsonb,jsonb) owner to postgres;
alter function public.sps_guard_accepted_stop_reports() owner to postgres;
alter function public.sps_stop_completion_batch_cas(jsonb,text,text,text) owner to postgres;
alter function public.sps_activate_stop_report_guard() owner to postgres;
revoke all on function public.sps_stop_state_decode(jsonb), public.sps_stop_state_encode(jsonb,jsonb),
  public.sps_stop_guard_client_items(jsonb,jsonb,jsonb),public.sps_stop_guard_clients(jsonb,jsonb,jsonb),public.sps_stop_guard_completed(jsonb,jsonb,jsonb),
  public.sps_guard_accepted_stop_reports(),public.sps_stop_completion_batch_cas(jsonb,text,text,text),
  public.sps_activate_stop_report_guard() from public,anon,authenticated,service_role;
grant execute on function public.sps_stop_completion_batch_cas(jsonb,text,text,text),
  public.sps_activate_stop_report_guard() to service_role;
commit;
