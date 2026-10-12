-- Administrator-only, session-local recovery tool. Defining this function does not recover data.
-- Source: one public.sps_backups row identified by key, containing the original client array.
-- Requires the installed stop-report authority migration. Apply also requires activated protection.
-- No emails, inventory, invoice, schedule, completion, or client profile changes are performed.
--
-- Run this definition and invocation together in the same administrator SQL session:
--   begin;
--   select set_config('request.jwt.claims','{"role":"service_role"}',true);
--   -- [this function definition]
--   select pg_temp.sps_recover_stop_reports_from_backup('EXACT_BACKUP_KEY'); -- dry run default
--   rollback;
--
-- After reviewing the counts, apply in a new transaction with the same definition:
--   select pg_temp.sps_recover_stop_reports_from_backup('EXACT_BACKUP_KEY',true);
--   commit;
-- Any invalid RPC result or verification failure aborts the entire transaction, including its backup.
-- The successful apply's guard backup contains exact raw clients/completed rows before recovery.
-- Results contain counts only. No report text, contact details, or photo data are returned.
create or replace function pg_temp.sps_recover_stop_reports_from_backup(
  p_source_backup_key text,
  p_apply boolean default false
) returns jsonb language plpgsql set search_path=pg_catalog as $recovery$
declare
  source_text text; source_clients jsonb; source_reports jsonb;
  clients jsonb; completed jsonb; next_clients jsonb; raw_clients jsonb;
  clients_version bigint; completed_version bigint;
  candidate jsonb; marker jsonb; receipt jsonb; old_history jsonb;
  candidates jsonb := '[]'; client_index integer;
  entry jsonb; client_id text; stop_id text; v_receipt_id text;
  source_count integer; eligible_count integer := 0; recovered_count integer := 0;
  present_count integer := 0; skipped_count integer := 0; response record;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'report_recovery_requires_service_context' using errcode='42501';
  end if;
  if nullif(btrim(p_source_backup_key),'') is null then
    raise exception 'report_recovery_backup_key_required' using errcode='22023';
  end if;
  if (select count(*) from public.sps_backups b where b.key=p_source_backup_key)<>1 then
    raise exception 'report_recovery_backup_missing_or_ambiguous' using errcode='22023';
  end if;
  select b.value into source_text from public.sps_backups b where b.key=p_source_backup_key;
  source_clients := public.sps_stop_state_decode(source_text::jsonb);
  if jsonb_typeof(source_clients) is distinct from 'array' then
    raise exception 'report_recovery_backup_shape_invalid' using errcode='22023';
  end if;
  -- Same row-lock order as the restricted and generic batch writers.
  perform a.key from public.app_state a where a.key in ('sps_clients','sps_completed') order by a.key for update;
  select a.value,public.sps_stop_state_decode(a.value),a.version into raw_clients,clients,clients_version
    from public.app_state a where a.key='sps_clients';
  select public.sps_stop_state_decode(a.value),a.version into completed,completed_version
    from public.app_state a where a.key='sps_completed';
  if jsonb_typeof(clients) is distinct from 'array' or jsonb_typeof(completed) is distinct from 'object'
    or clients_version is null or completed_version is null then
    raise exception 'report_recovery_current_state_invalid' using errcode='22023';
  end if;
  if p_apply and not coalesce((select enabled from public.sps_stop_report_guard_config where singleton),false) then
    raise exception 'report_recovery_requires_active_guard' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('clientId',c->>'id','entry',h)),'[]') into source_reports
    from jsonb_array_elements(source_clients) c
    cross join lateral jsonb_array_elements(case when jsonb_typeof(c->'history')='array' then c->'history' else '[]'::jsonb end) h
    where nullif(h->>'completionReceiptId','') is not null;
  source_count := jsonb_array_length(source_reports);
  for candidate in select value from jsonb_array_elements(source_reports) loop
    entry := candidate->'entry'; client_id := candidate->>'clientId';
    stop_id := entry->>'sid'; v_receipt_id := entry->>'completionReceiptId';
    marker := completed->stop_id;
    receipt := completed->'__stopReversalReceipts'->v_receipt_id;
    if nullif(client_id,'') is null or nullif(stop_id,'') is null
      or stop_id in ('__stopReversalReceipts','__stopReversedRequests')
      or (select count(*) from jsonb_array_elements(source_reports) r where r->'entry'->>'completionReceiptId'=v_receipt_id)<>1
      or (select count(*) from jsonb_array_elements(source_reports) r where r->'entry'->>'sid'=stop_id)<>1
      or (select count(*) from jsonb_array_elements(source_clients) c where c->>'id'=client_id)<>1
      or (select count(*) from jsonb_array_elements(clients) c where c->>'id'=client_id)<>1
      or marker->>'v' is distinct from '2' or marker->>'receiptId' is distinct from v_receipt_id
      or receipt->>'v' is distinct from '1' or receipt->>'id' is distinct from v_receipt_id
      or receipt->>'sid' is distinct from stop_id or receipt->>'clientId' is distinct from client_id
      or receipt->'history'->>'entryReceiptId' is distinct from v_receipt_id
      or nullif(receipt->>'completedAt','') is null
      or marker->>'completedAt' is distinct from receipt->>'completedAt'
      or length(coalesce(receipt->>'idempotencyKey',''))<8
      or exists(select 1 from public.sps_stop_report_reversals r where r.receipt_id=v_receipt_id)
      or (nullif(btrim(coalesce(entry->>'notes','')),'') is null and coalesce(entry->'photos','[]')='[]'::jsonb
        and not exists(select 1 from jsonb_each_text(case when jsonb_typeof(entry->'readings')='object' then entry->'readings' else '{}'::jsonb end) r where r.value is not null and r.value not in ('','—'))) then
      skipped_count := skipped_count+1; continue;
    end if;
    -- A competing receipt OR stop report anywhere in current clients requires human review.
    if exists(select 1 from jsonb_array_elements(clients) c
      cross join lateral jsonb_array_elements(case when jsonb_typeof(c->'history')='array' then c->'history' else '[]'::jsonb end) h
      where h->>'completionReceiptId'=v_receipt_id or h->>'sid'=stop_id) then
      present_count := present_count+1; continue;
    end if;
    candidates := candidates || jsonb_build_array(candidate);
    eligible_count := eligible_count+1;
  end loop;
  if not p_apply or eligible_count=0 then
    return jsonb_build_object('dry_run',not p_apply,'source_reports',source_count,'eligible_reports',eligible_count,
      'existing_or_competing_reports',present_count,'skipped_unmatched_or_ambiguous',skipped_count,'recovered_reports',0);
  end if;
  insert into public.sps_stop_report_guard_backups(reason,rows)
    select 'missing-report-recovery:'||p_source_backup_key,coalesce(jsonb_agg(to_jsonb(a) order by a.key),'[]')
    from public.app_state a where a.key in ('sps_clients','sps_completed');
  for candidate in select value from jsonb_array_elements(candidates) loop
    entry := candidate->'entry'; client_id := candidate->>'clientId';
    stop_id := entry->>'sid'; v_receipt_id := entry->>'completionReceiptId';
    select (c.ordinality-1)::integer,case when jsonb_typeof(c.value->'history')='array' then c.value->'history' else '[]'::jsonb end
      into client_index,old_history from jsonb_array_elements(clients) with ordinality c(value,ordinality)
      where c.value->>'id'=client_id;
    next_clients := jsonb_set(clients,array[client_index::text,'history'],jsonb_build_array(entry)||old_history);
    select * into response from public.sps_stop_completion_batch_cas(jsonb_build_array(
      jsonb_build_object('key','sps_clients','expected_version',clients_version,'value',public.sps_stop_state_encode(next_clients,raw_clients)),
      jsonb_build_object('key','sps_completed','expected_version',completed_version,'check_only',true)
    ),'edit',stop_id,v_receipt_id);
    if response.applied is distinct from true then raise exception 'report_recovery_not_applied'; end if;
    select a.value,public.sps_stop_state_decode(a.value),a.version into raw_clients,clients,clients_version
      from public.app_state a where a.key='sps_clients';
    if clients is distinct from next_clients then raise exception 'report_recovery_value_unconfirmed'; end if;
    recovered_count := recovered_count+1;
  end loop;
  return jsonb_build_object('dry_run',false,'source_reports',source_count,'eligible_reports',eligible_count,
    'existing_or_competing_reports',present_count,'skipped_unmatched_or_ambiguous',skipped_count,'recovered_reports',recovered_count);
end $recovery$;
