-- Administrator-only recovery tool. Defining this session-local function changes no app data.
-- Source: one public.sps_backups row containing the original client array.
-- Dry run is the default. APPLY REQUIRES ONE EXPLICIT RECEIPT ID and recovers at most one report.
-- Never invoke multiple recoveries inside the same transaction or anonymous DO block.
-- Use run-stop-report-backup-recovery.mjs to generate a no-DDL transaction for one invocation.
-- No email, invoice, inventory, schedule, completion, or client profile changes are performed.
-- The first apply per source key saves exact raw clients/completed rows once. Each repair keeps
-- a small undo descriptor identifying only its inserted report and active completion receipt.
-- No undo is executed here. Failure rolls back that repair and its new backup metadata.
create or replace function pg_temp.sps_recover_stop_reports_from_backup(
  p_source_backup_key text,
  p_apply boolean default false,
  p_receipt_id text default null
) returns jsonb language plpgsql set search_path=pg_catalog as $recovery$
declare
  source_meta jsonb := '{"clientIds":[],"reports":[]}'; current_meta jsonb := '{"clientIds":[],"reports":[]}'; completed jsonb;
  scanned_client json; scanned_entry json; has_content boolean;
  clients_version bigint; completed_version bigint;
  candidate jsonb; selected jsonb; marker jsonb; receipt jsonb; eligible_receipts jsonb := '[]';
  client_id text; stop_id text; v_receipt_id text;
  source_count integer; eligible_count integer := 0;
  present_count integer := 0; skipped_count integer := 0; response record;
begin
  p_apply := coalesce(p_apply,false);
  p_receipt_id := nullif(btrim(p_receipt_id),'');
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'report_recovery_requires_service_context' using errcode='42501';
  end if;
  if nullif(btrim(p_source_backup_key),'') is null then
    raise exception 'report_recovery_backup_key_required' using errcode='22023';
  end if;
  if p_apply and (p_receipt_id is null or length(p_receipt_id)>320) then
    raise exception 'report_recovery_requires_one_receipt_id' using errcode='22023';
  end if;
  -- Apply takes the compact path before scanning either full roster in this caller.
  -- The restricted RPC derives one exact archived entry, validates both versions, and owns
  -- its baseline, scoped mutation, and confirmation in this transaction.
  if p_apply then
    select a.version into clients_version from public.app_state a where a.key='sps_clients';
    select a.version into completed_version from public.app_state a where a.key='sps_completed';
    select * into response from public.sps_restore_stop_report_cas(
      p_source_backup_key,p_receipt_id,clients_version,completed_version);
    if response.outcome not in ('restored','already-present') then
      raise exception 'report_recovery_not_applied_%',response.outcome;
    end if;
    return jsonb_build_object('dry_run',false,'recovered_reports',case when response.applied then 1 else 0 end,
      'outcome',response.outcome,'clients_version',response.current_clients_version,
      'completed_version',response.current_completed_version);
  end if;
  if (select count(*) from public.sps_backups b where b.key=p_source_backup_key)<>1 then
    raise exception 'report_recovery_backup_missing_or_ambiguous' using errcode='22023';
  end if;
  -- Scan archive JSON text into small metadata without constructing a photo-bearing JSONB tree.
  for scanned_client in select c from public.sps_backups b cross join lateral json_array_elements(b.value::json) c where b.key=p_source_backup_key loop
    source_meta := jsonb_set(source_meta,'{clientIds}',source_meta->'clientIds'||jsonb_build_array(scanned_client->>'id'));
    for scanned_entry in select h from json_array_elements(case when json_typeof(scanned_client->'history')='array' then scanned_client->'history' else '[]'::json end) h loop
      if nullif(scanned_entry->>'completionReceiptId','') is null then continue; end if;
      has_content := nullif(btrim(coalesce(scanned_entry->>'notes','')),'') is not null
        or (case when json_typeof(scanned_entry->'photos')='array' then json_array_length(scanned_entry->'photos')>0 else false end)
        or exists(select 1 from json_each_text(case when json_typeof(scanned_entry->'readings')='object' then scanned_entry->'readings' else '{}'::json end) r where r.value is not null and r.value not in ('','—'));
      source_meta := jsonb_set(source_meta,'{reports}',source_meta->'reports'||jsonb_build_array(jsonb_build_object(
        'clientId',scanned_client->>'id','sid',scanned_entry->>'sid','receiptId',scanned_entry->>'completionReceiptId','hasContent',has_content)));
    end loop;
  end loop;
  scanned_client := null; scanned_entry := null;
  if p_receipt_id is not null and (select count(*) from jsonb_array_elements(source_meta->'reports') r where r->>'receiptId'=p_receipt_id)<>1 then
    raise exception 'report_recovery_selected_receipt_missing_or_ambiguous' using errcode='22023';
  end if;
  -- Same row-lock order as generic and restricted writers. Lock only after archive parsing ends.
  perform a.key from public.app_state a where a.key in ('sps_clients','sps_completed') order by a.key for update;
  select a.version into clients_version from public.app_state a where a.key='sps_clients';
  for scanned_client in select c from public.app_state a cross join lateral json_array_elements(public.sps_stop_state_json_text(a.value)::json) c where a.key='sps_clients' loop
    current_meta := jsonb_set(current_meta,'{clientIds}',current_meta->'clientIds'||jsonb_build_array(scanned_client->>'id'));
    for scanned_entry in select h from json_array_elements(case when json_typeof(scanned_client->'history')='array' then scanned_client->'history' else '[]'::json end) h loop
      current_meta := jsonb_set(current_meta,'{reports}',current_meta->'reports'||jsonb_build_array(jsonb_build_object('sid',scanned_entry->>'sid','receiptId',scanned_entry->>'completionReceiptId')));
    end loop;
  end loop;
  scanned_client := null; scanned_entry := null;
  select public.sps_stop_state_decode(a.value),a.version into completed,completed_version from public.app_state a where a.key='sps_completed';
  if jsonb_typeof(completed) is distinct from 'object' or clients_version is null or completed_version is null then
    raise exception 'report_recovery_current_state_invalid' using errcode='22023';
  end if;
  if p_apply and not coalesce((select enabled from public.sps_stop_report_guard_config where singleton),false) then
    raise exception 'report_recovery_requires_active_guard' using errcode='42501';
  end if;
  source_count := jsonb_array_length(source_meta->'reports');
  for candidate in select value from jsonb_array_elements(source_meta->'reports') loop
    client_id := candidate->>'clientId'; stop_id := candidate->>'sid'; v_receipt_id := candidate->>'receiptId';
    marker := completed->stop_id; receipt := completed->'__stopReversalReceipts'->v_receipt_id;
    if nullif(client_id,'') is null or nullif(stop_id,'') is null
      or stop_id in ('__stopReversalReceipts','__stopReversedRequests')
      or (select count(*) from jsonb_array_elements(source_meta->'reports') r where r->>'receiptId'=v_receipt_id)<>1
      or (select count(*) from jsonb_array_elements(source_meta->'reports') r where r->>'sid'=stop_id)<>1
      or (select count(*) from jsonb_array_elements_text(source_meta->'clientIds') c where c=client_id)<>1
      or (select count(*) from jsonb_array_elements_text(current_meta->'clientIds') c where c=client_id)<>1
      or marker->>'v' is distinct from '2' or marker->>'receiptId' is distinct from v_receipt_id
      or receipt->>'v' is distinct from '1' or receipt->>'id' is distinct from v_receipt_id
      or receipt->>'sid' is distinct from stop_id or receipt->>'clientId' is distinct from client_id
      or receipt->'history'->>'entryReceiptId' is distinct from v_receipt_id
      or nullif(receipt->>'completedAt','') is null or marker->>'completedAt' is distinct from receipt->>'completedAt'
      or length(coalesce(receipt->>'idempotencyKey',''))<8
      or coalesce(completed->'__stopReversedRequests' ? v_receipt_id,false)
      or exists(select 1 from public.sps_stop_report_reversals r where r.receipt_id=v_receipt_id)
      or candidate->'hasContent' is distinct from 'true'::jsonb then
      skipped_count := skipped_count+1; continue;
    end if;
    if exists(select 1 from jsonb_array_elements(current_meta->'reports') h where h->>'receiptId'=v_receipt_id or h->>'sid'=stop_id) then
      present_count := present_count+1; continue;
    end if;
    eligible_count := eligible_count+1;
    eligible_receipts := eligible_receipts || jsonb_build_array(jsonb_build_object('clientId',client_id,'sid',stop_id,'receiptId',v_receipt_id));
    if v_receipt_id=p_receipt_id then selected := candidate; end if;
  end loop;
  return jsonb_build_object('dry_run',true,'source_reports',source_count,'eligible_reports',eligible_count,
    'selected_receipt_eligible',selected is not null,'existing_or_competing_reports',present_count,
    'skipped_unmatched_or_ambiguous',skipped_count,'recovered_reports',0,'eligible_receipts',eligible_receipts);
end $recovery$;
