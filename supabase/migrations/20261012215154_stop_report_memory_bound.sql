-- Bound ordinary stop/report RPC memory using a compact target-client delta.
-- Preserve the installed generic report guard and its activation state.
begin;

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
  -- Only the restricted stop/report RPC sets this flag after exact delta proof.
  -- Check it before touching either large row value. Generic writers keep the
  -- installed same-row report-preservation path unchanged.
  if new.key='sps_clients' and context->'clientsValidated'='true'::jsonb
    and context->>'mode' in ('complete','reverse','edit') then return new; end if;
  old_value := case when tg_op='UPDATE' then public.sps_stop_state_decode(old.value) else null end;
  incoming_value := public.sps_stop_state_decode(new.value); value := incoming_value;
  if new.key='sps_clients' then value := public.sps_stop_guard_clients(old_value,value,context);
  else value := public.sps_stop_guard_completed(old_value,value,context); end if;
  -- Keep the caller's exact string bytes when no report protection changed data.
  -- Older client save fences compare serialized strings, including key order.
  if value is distinct from incoming_value then new.value := public.sps_stop_state_encode(value,new.value); end if;
  return new;
end $f$;
create or replace function public.sps_stop_completion_batch_cas(
  p_operations jsonb, p_mode text, p_sid text, p_receipt_id text
) returns table (applied boolean, outcome text, conflict_key text, current_versions jsonb)
language plpgsql security definer set search_path = pg_catalog set row_security = off as $f$
declare
  op jsonb; k text; current_version bigint; versions jsonb := '{}'; conflict text;
  old_clients jsonb; new_clients jsonb; old_completed jsonb; new_completed jsonb;
  old_marker jsonb; new_marker jsonb; verified_receipt jsonb; saved_report jsonb; new_report jsonb;
  client_id text; report_count integer; old_report_count integer; clients_validated boolean := false;
  result record; reversal jsonb; expected_clients jsonb; old_history jsonb; expected_client jsonb; incoming_client jsonb; ci integer; hi integer; balance_key text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'stop_mutation_service_only' using errcode='42501'; end if;
  perform set_config('sps.stop_report_write','',true);
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
  if p_mode='edit' then
    clients_validated := true;
  elsif p_receipt_id<>'' then
    select (c.ordinality-1)::integer into ci from jsonb_array_elements(old_clients) with ordinality c(value,ordinality)
      where c.value->>'id'=client_id;
    expected_client := old_clients->ci;
    incoming_client := new_clients->ci;
    old_history := case when jsonb_typeof(expected_client->'history')='array' then expected_client->'history' else '[]'::jsonb end;
    if p_mode='complete' then
      -- The current server posts work to review, not customer debt.
      expected_client := jsonb_set(expected_client,'{history}',jsonb_build_array(new_report)||old_history);
    else
      select coalesce(jsonb_agg(h.value order by h.ordinality),'[]') into old_history
        from jsonb_array_elements(old_history) with ordinality h(value,ordinality)
        where h.value->>'completionReceiptId' is distinct from p_receipt_id;
      if verified_receipt->'history'->'historyHadOwn'='false'::jsonb and old_history='[]'::jsonb then
        expected_client := expected_client-'history';
      else expected_client := jsonb_set(expected_client,'{history}',old_history); end if;
      -- Legacy receipts may restore balance ownership; all other client fields
      -- and every other report remain byte-for-byte equal as JSON values.
      if verified_receipt->'balance'->'changed'='true'::jsonb then
        foreach balance_key in array array['balance','__spsCompletionBalanceReceipt'] loop
          if incoming_client ? balance_key then expected_client := jsonb_set(expected_client,array[balance_key],incoming_client->balance_key);
          else expected_client := expected_client-balance_key; end if;
        end loop;
      end if;
    end if;
    expected_clients := jsonb_set(old_clients,array[ci::text],expected_client);
    if new_clients is distinct from expected_clients then raise exception 'stop_mutation_changed_unrelated_client_data' using errcode='22023'; end if;
    clients_validated := true;
  end if;
  -- Drop large decoded documents before the nested generic CAS and its trigger.
  -- p_operations is the only remaining full clients payload in this function.
  old_clients := null; new_clients := null; expected_clients := null;
  expected_client := null; incoming_client := null; old_history := null;
  new_report := null; op := null;
  perform set_config('sps.stop_report_write',jsonb_build_object('mode',p_mode,'sid',p_sid,'receipt',p_receipt_id,'clientsValidated',clients_validated)::text,true);
  select * into result from public.sps_app_state_batch_cas(p_operations);
  if result.applied and p_mode='reverse' then
    insert into public.sps_stop_report_reversals(sid,receipt_id,report,marker,receipt)
      values(p_sid,p_receipt_id,saved_report,old_marker,verified_receipt) on conflict (sid,receipt_id) do nothing;
  end if;
  perform set_config('sps.stop_report_write','',true);
  return query select result.applied,result.outcome,result.conflict_key,result.current_versions;
exception when others then
  perform set_config('sps.stop_report_write','',true);
  raise;
end $f$;

-- A tiny template retains historical wire depth without parsing a second copy
-- of a large clients document just to discover that depth.
create or replace function public.sps_stop_state_wire_template(p_value jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $f$
begin
  if jsonb_typeof(p_value) is distinct from 'string' then return '[]'::jsonb; end if;
  if left(ltrim(p_value #>> '{}'),1)='"' then return to_jsonb(to_jsonb('[]'::text)::text); end if;
  return to_jsonb('[]'::text);
end $f$;
-- Keep array text as JSON while scanning. Only one target client becomes a
-- JSONB tree; the surrounding photos never need to be parsed and copied twice.
create or replace function public.sps_stop_state_json_text(p_value jsonb)
returns text language plpgsql immutable set search_path=pg_catalog as $f$
declare raw_value text; i integer;
begin
  if jsonb_typeof(p_value)<>'string' then return p_value::text; end if;
  raw_value:=p_value #>> '{}';
  for i in 1..2 loop
    if left(ltrim(raw_value),1)<>'"' then return raw_value; end if;
    raw_value:=(raw_value::json #>> '{}');
  end loop;
  raise exception 'stop_state_encoding_invalid' using errcode='22023';
end $f$;
create or replace function public.sps_stop_client_target_wire(p_value jsonb,p_client_id text,p_receipt_id text)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $f$
declare raw_value text; item json; h json; target jsonb; target_index integer; matches integer:=0; receipts integer:=0; i integer:=0;
begin
  raw_value:=public.sps_stop_state_json_text(p_value);
  if json_typeof(raw_value::json)<>'array' then raise exception 'stop_mutation_state_invalid' using errcode='22023'; end if;
  for item in select value from json_array_elements(raw_value::json) loop
    if item->>'id'=p_client_id then matches:=matches+1; target:=item::jsonb; target_index:=i; end if;
    if p_receipt_id<>'' and json_typeof(item->'history')='array' then
      for h in select value from json_array_elements(item->'history') loop
        if h->>'completionReceiptId'=p_receipt_id then receipts:=receipts+1; end if;
      end loop;
    end if;
    i:=i+1;
  end loop;
  return jsonb_build_object('client',target,'index',target_index,'matches',matches,'receipts',receipts);
end $f$;
create or replace function public.sps_stop_replace_client_value(p_value jsonb,p_index integer,p_client jsonb,p_template jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $f$
declare raw_value text; replacement text; item json; cursor_pos integer:=1; item_start integer; i integer:=0;
begin
  raw_value:=public.sps_stop_state_json_text(p_value);
  if json_typeof(raw_value::json)<>'array' then raise exception 'stop_mutation_state_invalid' using errcode='22023'; end if;
  -- JSON input is validated above. Advance across whole element texts and only
  -- the array delimiters/JSON whitespace, so an identical nested object cannot
  -- be mistaken for the top-level client being replaced.
  cursor_pos:=strpos(raw_value,'[')+1;
  for item in select value from json_array_elements(raw_value::json) loop
    while substring(raw_value from cursor_pos for 1) in (' ',E'\t',E'\r',E'\n',',') loop cursor_pos:=cursor_pos+1; end loop;
    item_start:=cursor_pos; cursor_pos:=cursor_pos+length(item::text);
    if i=p_index then
      replacement:=substring(raw_value from 1 for item_start-1)||p_client::text||substring(raw_value from cursor_pos);
      raw_value:=null;
      if jsonb_typeof(p_template)<>'string' then return replacement::jsonb; end if;
      if left(ltrim(p_template #>> '{}'),1)='"' then return to_jsonb(to_jsonb(replacement)::text); end if;
      return to_jsonb(replacement);
    end if;
    i:=i+1;
  end loop;
  raise exception 'stop_client_index_missing' using errcode='22023';
end $f$;

create or replace function public.sps_stop_completion_delta_cas(
  p_operations jsonb, p_mode text, p_sid text, p_receipt_id text, p_client_id text
) returns table (applied boolean, outcome text, conflict_key text, current_versions jsonb)
language plpgsql security definer set search_path = pg_catalog set row_security = off as $f$
declare
  target_info jsonb; target_index integer; global_receipts integer; client_delta jsonb; small_operations jsonb; wire_template jsonb;
  op jsonb; k text; current_version bigint; versions jsonb := '{}'; conflict text;
  old_clients jsonb; new_clients jsonb; old_completed jsonb; new_completed jsonb;
  old_marker jsonb; new_marker jsonb; verified_receipt jsonb; saved_report jsonb; new_report jsonb;
  client_id text; report_count integer; old_report_count integer; clients_validated boolean := false;
  result record; reversal jsonb; expected_clients jsonb; old_history jsonb; expected_client jsonb; incoming_client jsonb; ci integer; hi integer; balance_key text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'stop_mutation_service_only' using errcode='42501'; end if;
  perform set_config('sps.stop_report_write','',true);
  if nullif(btrim(p_client_id),'') is null or length(p_client_id)>320 then raise exception 'stop_client_identity_invalid' using errcode='22023'; end if;
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
  select public.sps_stop_client_target_wire(a.value,p_client_id,p_receipt_id),
    public.sps_stop_state_wire_template(a.value) into target_info,wire_template
    from public.app_state a where a.key='sps_clients';
  if target_info is null or (target_info->>'matches')::integer<>1 then
    raise exception 'stop_receipt_client_ambiguous' using errcode='22023'; end if;
  target_index := (target_info->>'index')::integer;
  global_receipts := (target_info->>'receipts')::integer;
  old_clients := jsonb_build_array(target_info->'client'); target_info := null;
  select public.sps_stop_state_decode(a.value) into old_completed from public.app_state a where a.key='sps_completed';
  old_completed := coalesce(old_completed,'{}');
  select jsonb_build_array(public.sps_stop_state_decode(e->'value')) into new_clients from jsonb_array_elements(p_operations) e where e->>'key'='sps_clients';
  select public.sps_stop_state_decode(e->'value') into new_completed from jsonb_array_elements(p_operations) e where e->>'key'='sps_completed';
  if jsonb_typeof(old_clients) is distinct from 'array' or jsonb_typeof(new_clients) is distinct from 'array'
    or jsonb_typeof(old_completed)<>'object' or (p_mode<>'edit' and jsonb_typeof(new_completed) is distinct from 'object') then
    raise exception 'stop_mutation_state_invalid' using errcode='22023';
  end if;
  if new_clients->0->>'id' is distinct from p_client_id then raise exception 'stop_client_identity_invalid' using errcode='22023'; end if;
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
    if client_id is distinct from p_client_id then raise exception 'stop_receipt_client_mismatch' using errcode='22023'; end if;
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
    if global_receipts<>report_count then raise exception 'stop_existing_report_identity_invalid' using errcode='22023'; end if;
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
  if p_mode='edit' then
    clients_validated := true;
  elsif p_receipt_id<>'' then
    select (c.ordinality-1)::integer into ci from jsonb_array_elements(old_clients) with ordinality c(value,ordinality)
      where c.value->>'id'=client_id;
    expected_client := old_clients->ci;
    incoming_client := new_clients->ci;
    old_history := case when jsonb_typeof(expected_client->'history')='array' then expected_client->'history' else '[]'::jsonb end;
    if p_mode='complete' then
      -- The current server posts work to review, not customer debt.
      expected_client := jsonb_set(expected_client,'{history}',jsonb_build_array(new_report)||old_history);
    else
      select coalesce(jsonb_agg(h.value order by h.ordinality),'[]') into old_history
        from jsonb_array_elements(old_history) with ordinality h(value,ordinality)
        where h.value->>'completionReceiptId' is distinct from p_receipt_id;
      if verified_receipt->'history'->'historyHadOwn'='false'::jsonb and old_history='[]'::jsonb then
        expected_client := expected_client-'history';
      else expected_client := jsonb_set(expected_client,'{history}',old_history); end if;
      -- Legacy receipts may restore balance ownership; all other client fields
      -- and every other report remain byte-for-byte equal as JSON values.
      if verified_receipt->'balance'->'changed'='true'::jsonb then
        foreach balance_key in array array['balance','__spsCompletionBalanceReceipt'] loop
          if incoming_client ? balance_key then expected_client := jsonb_set(expected_client,array[balance_key],incoming_client->balance_key);
          else expected_client := expected_client-balance_key; end if;
        end loop;
      end if;
    end if;
    expected_clients := jsonb_set(old_clients,array[ci::text],expected_client);
    if new_clients is distinct from expected_clients then raise exception 'stop_mutation_changed_unrelated_client_data' using errcode='22023'; end if;
    clients_validated := true;
  end if;
  if p_receipt_id='' then
    -- Receipt-less legacy reopen removes only its first matching legacy history
    -- entry. It cannot erase a modern report or alter any other client field.
    expected_client := old_clients->0;
    old_history := case when jsonb_typeof(expected_client->'history')='array' then expected_client->'history' else '[]'::jsonb end;
    select (h.ordinality-1)::integer into hi from jsonb_array_elements(old_history) with ordinality h(value,ordinality)
      where h.value->>'sid'=p_sid order by h.ordinality limit 1;
    if hi is not null then
      if nullif(old_history->hi->>'completionReceiptId','') is not null then raise exception 'stop_legacy_reverse_contains_receipt' using errcode='22023'; end if;
      old_history := old_history-hi;
    end if;
    expected_client := jsonb_set(expected_client,'{history}',old_history);
    if new_clients->0 is distinct from expected_client then raise exception 'stop_mutation_changed_unrelated_client_data' using errcode='22023'; end if;
  end if;
  client_delta := new_clients->0;
  select jsonb_agg(case when e->>'key'='sps_clients' then (e-'value')||'{"check_only":true}'::jsonb else e end)
    into small_operations from jsonb_array_elements(p_operations) e;
  -- No full clients document crosses a nested RPC or lives in this function.
  p_operations := null; old_clients := null; new_clients := null; expected_clients := null;
  expected_client := null; incoming_client := null; old_history := null; new_report := null; op := null;
  perform set_config('sps.stop_report_write',jsonb_build_object('mode',p_mode,'sid',p_sid,'receipt',p_receipt_id,'clientsValidated',true)::text,true);
  select * into result from public.sps_app_state_batch_cas(small_operations);
  if result.applied then
    update public.app_state a set value=public.sps_stop_replace_client_value(a.value,target_index,client_delta,wire_template)
      where a.key='sps_clients' and a.version=(versions->>'sps_clients')::bigint returning a.version into current_version;
    if current_version is distinct from (versions->>'sps_clients')::bigint+1 then
      raise exception 'stop_clients_update_not_applied' using errcode='40001'; end if;
    result.current_versions := jsonb_set(result.current_versions,'{sps_clients}',to_jsonb(current_version));
    if p_mode='reverse' then
      insert into public.sps_stop_report_reversals(sid,receipt_id,report,marker,receipt)
        values(p_sid,p_receipt_id,saved_report,old_marker,verified_receipt) on conflict (sid,receipt_id) do nothing;
    end if;
  end if;
  perform set_config('sps.stop_report_write','',true);
  return query select result.applied,result.outcome,result.conflict_key,result.current_versions;
exception when others then
  perform set_config('sps.stop_report_write','',true);
  raise;
end $f$;

alter function public.sps_stop_state_json_text(jsonb) owner to postgres;
alter function public.sps_stop_client_target_wire(jsonb,text,text) owner to postgres;
revoke all on function public.sps_stop_state_json_text(jsonb),public.sps_stop_client_target_wire(jsonb,text,text) from public,anon,authenticated,service_role;
alter function public.sps_stop_replace_client_value(jsonb,integer,jsonb,jsonb) owner to postgres;
revoke all on function public.sps_stop_replace_client_value(jsonb,integer,jsonb,jsonb) from public,anon,authenticated,service_role;
alter function public.sps_stop_state_wire_template(jsonb) owner to postgres;
alter function public.sps_stop_completion_delta_cas(jsonb,text,text,text,text) owner to postgres;
revoke all on function public.sps_stop_state_wire_template(jsonb),public.sps_stop_completion_delta_cas(jsonb,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.sps_stop_completion_delta_cas(jsonb,text,text,text,text) to service_role;

-- Existing function ownership/grants survive CREATE OR REPLACE. No activation change.
commit;
