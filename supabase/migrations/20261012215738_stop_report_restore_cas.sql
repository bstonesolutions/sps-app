-- Restore one exact archived report without passing a full clients snapshot through nested RPCs.
-- This service-only operation derives its payload from sps_backups and requires active authority.
begin;
create or replace function public.sps_restore_stop_report_cas(
  p_source_backup_key text,p_receipt_id text,p_expected_clients_version bigint,p_expected_completed_version bigint
) returns table(applied boolean,outcome text,current_clients_version bigint,current_completed_version bigint)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $restore$
declare
  source_client json; source_entry json; wire_client json; wire_entry json; current_item record;
  client_counts jsonb := '{}'; sid_counts jsonb := '{}'; entry jsonb; client_id text; stop_id text;
  clients jsonb; client jsonb; history jsonb; completed jsonb; marker jsonb; receipt jsonb;
  source_matches integer := 0; client_matches integer := 0; existing_matches integer := 0;
  ci integer; identity text; new_version bigint; encoding_template jsonb;
  clients_version bigint; completed_version bigint; entry_digest text; active_digest text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'report_restore_service_only' using errcode='42501'; end if;
  perform set_config('sps.stop_report_write','',true);
  if nullif(btrim(p_source_backup_key),'') is null or nullif(btrim(p_receipt_id),'') is null
    or length(p_receipt_id)>320 or p_expected_clients_version is null or p_expected_clients_version<1
    or p_expected_completed_version is null or p_expected_completed_version<1 then
    raise exception 'report_restore_identity_invalid' using errcode='22023';
  end if;
  if not coalesce((select enabled from public.sps_stop_report_guard_config where singleton),false) then
    raise exception 'report_recovery_requires_active_guard' using errcode='42501';
  end if;
  perform a.key from public.app_state a where a.key in ('sps_clients','sps_completed') order by a.key for update;
  select a.version into clients_version from public.app_state a where a.key='sps_clients';
  select a.version into completed_version from public.app_state a where a.key='sps_completed';
  if clients_version is distinct from p_expected_clients_version or completed_version is distinct from p_expected_completed_version then
    return query select false,'conflict'::text,coalesce(clients_version,0),coalesce(completed_version,0); return;
  end if;
  perform b.key from public.sps_backups b where b.key=p_source_backup_key for share;
  if (select count(*) from public.sps_backups b where b.key=p_source_backup_key)<>1 then
    raise exception 'report_recovery_backup_missing_or_ambiguous' using errcode='22023';
  end if;
  -- Parse archive text as JSON and retain only each client/report while scanning. Building
  -- a second full JSONB tree here needlessly copies every legacy photo before current-state work.
  for source_client in select c from public.sps_backups b
    cross join lateral json_array_elements(b.value::json) c where b.key=p_source_backup_key loop
    identity := source_client->>'id';
    if identity is not null then client_counts := jsonb_set(client_counts,array[identity],to_jsonb(coalesce((client_counts->>identity)::integer,0)+1)); end if;
    for source_entry in select h from json_array_elements(case when json_typeof(source_client->'history')='array' then source_client->'history' else '[]'::json end) h loop
      if nullif(source_entry->>'completionReceiptId','') is null then continue; end if;
      identity := source_entry->>'sid';
      if identity is not null then sid_counts := jsonb_set(sid_counts,array[identity],to_jsonb(coalesce((sid_counts->>identity)::integer,0)+1)); end if;
      if source_entry->>'completionReceiptId'=p_receipt_id then
        source_matches := source_matches+1; entry := source_entry::jsonb; client_id := source_client->>'id'; stop_id := identity;
      end if;
    end loop;
  end loop;
  source_client := null; source_entry := null;
  if source_matches<>1 or nullif(client_id,'') is null or nullif(stop_id,'') is null
    or stop_id in ('__stopReversalReceipts','__stopReversedRequests')
    or (client_counts->>client_id)::integer is distinct from 1 or (sid_counts->>stop_id)::integer is distinct from 1
    or (nullif(btrim(coalesce(entry->>'notes','')),'') is null and not (case when jsonb_typeof(entry->'photos')='array' then jsonb_array_length(entry->'photos')>0 else false end)
      and not exists(select 1 from jsonb_each_text(case when jsonb_typeof(entry->'readings')='object' then entry->'readings' else '{}'::jsonb end) r where r.value is not null and r.value not in ('','—'))) then
    raise exception 'report_recovery_selected_receipt_missing_or_ambiguous' using errcode='22023';
  end if;
  client_counts := null; sid_counts := null;
  select public.sps_stop_state_decode(a.value) into completed from public.app_state a where a.key='sps_completed';
  marker := completed->stop_id; receipt := completed->'__stopReversalReceipts'->p_receipt_id;
  if jsonb_typeof(completed) is distinct from 'object'
    or marker->>'v' is distinct from '2' or marker->>'receiptId' is distinct from p_receipt_id
    or receipt->>'v' is distinct from '1' or receipt->>'id' is distinct from p_receipt_id
    or receipt->>'sid' is distinct from stop_id or receipt->>'clientId' is distinct from client_id
    or receipt->'history'->>'entryReceiptId' is distinct from p_receipt_id
    or nullif(receipt->>'completedAt','') is null or marker->>'completedAt' is distinct from receipt->>'completedAt'
    or length(coalesce(receipt->>'idempotencyKey',''))<8
    or coalesce(completed->'__stopReversedRequests' ? p_receipt_id,false)
    or exists(select 1 from public.sps_stop_report_reversals r where r.receipt_id=p_receipt_id) then
    raise exception 'report_restore_receipt_not_current' using errcode='22023';
  end if;
  entry_digest := md5(entry::text); active_digest := md5(jsonb_build_object('marker',marker,'receipt',receipt)::text);
  completed := null; marker := null; receipt := null;
  -- Inspect the encoded roster as JSON text; only the target client becomes JSONB.
  for current_item in select c.value,c.ordinality from public.app_state a
    cross join lateral json_array_elements(public.sps_stop_state_json_text(a.value)::json) with ordinality c(value,ordinality)
    where a.key='sps_clients' loop
    wire_client := current_item.value;
    if wire_client->>'id'=client_id then ci := current_item.ordinality-1; client := wire_client::jsonb; client_matches := client_matches+1; end if;
    for wire_entry in select h from json_array_elements(case when json_typeof(wire_client->'history')='array' then wire_client->'history' else '[]'::json end) h loop
      if wire_entry->>'completionReceiptId'=p_receipt_id or wire_entry->>'sid'=stop_id then existing_matches := existing_matches+1; end if;
    end loop;
  end loop;
  wire_client := null; wire_entry := null; current_item := null;
  select public.sps_stop_state_wire_template(a.value) into encoding_template from public.app_state a where a.key='sps_clients';
  if client_matches<>1 then raise exception 'report_restore_client_ambiguous' using errcode='22023'; end if;
  if existing_matches>0 then
    clients := null; client := null; history := null;
    return query select false,'already-present'::text,clients_version,completed_version; return;
  end if;
  -- The single baseline is created under the same locks. Later repairs add only tiny undo records.
  if not exists(select 1 from public.sps_stop_report_guard_backups b where b.reason='missing-report-recovery-baseline:'||p_source_backup_key) then
    insert into public.sps_stop_report_guard_backups(reason,rows)
      select 'missing-report-recovery-baseline:'||p_source_backup_key,coalesce(jsonb_agg(to_jsonb(a) order by a.key),'[]')
      from public.app_state a where a.key in ('sps_clients','sps_completed');
  end if;
  insert into public.sps_stop_report_guard_backups(reason,rows) values(
    'missing-report-recovery:'||p_source_backup_key||':'||p_receipt_id,
    jsonb_build_array(jsonb_build_object('key','sps_clients','version',clients_version,'recovery',jsonb_build_object(
      'kind','insert-missing-report','clientId',client_id,'sid',stop_id,'receiptId',p_receipt_id,'priorReport',null,
      'addedReportDigest',entry_digest,'activeReceiptDigest',active_digest
    )),jsonb_build_object('key','sps_completed','version',completed_version))
  );
  history := case when jsonb_typeof(client->'history')='array' then client->'history' else '[]'::jsonb end;
  client := jsonb_set(client,'{history}',jsonb_build_array(entry)||history);
  history := null;
  select public.sps_stop_replace_client_value(a.value,ci,client,encoding_template) into clients from public.app_state a where a.key='sps_clients';
  client := null;
  -- Exact mutation was constructed here under both row locks, never accepted as a full snapshot.
  perform set_config('sps.stop_report_write',jsonb_build_object('mode','edit','sid',stop_id,'receipt',p_receipt_id,'clientsValidated',true)::text,true);
  update public.app_state a set value=clients where a.key='sps_clients' and a.version=clients_version returning a.version into new_version;
  clients := null;
  perform set_config('sps.stop_report_write','',true);
  if new_version is distinct from clients_version+1 then raise exception 'report_recovery_not_applied'; end if;
  select json_extract_path(public.sps_stop_state_json_text(a.value)::json,ci::text) into wire_client from public.app_state a where a.key='sps_clients';
  if wire_client->>'id' is distinct from client_id or (wire_client->'history'->0)::jsonb is distinct from entry
    or not exists(select 1 from public.app_state a where a.key='sps_completed' and a.version=completed_version) then
    raise exception 'report_recovery_value_unconfirmed';
  end if;
  return query select true,'restored'::text,new_version,completed_version;
exception when others then
  perform set_config('sps.stop_report_write','',true);
  raise;
end $restore$;
alter function public.sps_restore_stop_report_cas(text,text,bigint,bigint) owner to postgres;
revoke all on function public.sps_restore_stop_report_cas(text,text,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.sps_restore_stop_report_cas(text,text,bigint,bigint) to service_role;
commit;
