-- Avoid repeated projections and authority-object copies for exact rows.
-- Stale-revision, identity, deletion, and genuine-change checks remain.
begin;

create or replace function public.sps_invoice_register_authority(p_id text,p_invoice jsonb,p_source text) returns void
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare previous public.sps_invoice_authority%rowtype;
begin
  select * into previous from public.sps_invoice_authority where invoice_id=p_id;
  -- Exact canonical refresh rows need no protected-field reconstruction.
  if found and previous.invoice is not distinct from (p_invoice-'qbWriteReview') then return; end if;
  if found and public.sps_invoice_protected_content(previous.invoice)=public.sps_invoice_protected_content(p_invoice) then return; end if;
  insert into public.sps_invoice_authority_history(invoice_id,invoice,source) values(p_id,p_invoice,p_source);
  insert into public.sps_invoice_authority(invoice_id,qb_id,invoice,source) values(p_id,nullif(btrim(p_invoice->>'qbId'),''),p_invoice-'qbWriteReview',p_source)
    on conflict(invoice_id) do update set qb_id=excluded.qb_id,invoice=excluded.invoice,source=excluded.source,
      revision=public.sps_invoice_authority.revision+1,confirmed_at=clock_timestamp();
end $f$;

create or replace function public.sps_invoice_canonical_cas(p_expected_version bigint,p_value jsonb,p_actor_id text,p_action text,
  p_authority jsonb default '{}',p_candidates jsonb default '{}',p_metadata_candidates jsonb default '{}',p_diagnostics jsonb default '{}')
returns table(applied boolean,outcome text,current_version bigint,changed_at timestamptz,value jsonb)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare claims jsonb; current_row public.app_state%rowtype; incoming jsonb; incoming_index jsonb; old_index jsonb; entry record; target jsonb; old_rows jsonb; result record; anchor public.sps_invoice_authority%rowtype;
begin
  claims:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}');
  if current_setting('role',true) is distinct from 'service_role' or coalesce(claims->>'role',current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'invoice_canonical_service_only' using errcode='42501'; end if;
  perform set_config('sps.invoice_canonical_write','',true);
  if p_expected_version is null or p_expected_version<1 or nullif(btrim(p_actor_id),'') is null or length(p_actor_id)>220
    or p_action is null or p_action not in ('quickbooks-refresh','quickbooks-create','quickbooks-update','quickbooks-payment')
    or jsonb_typeof(p_authority) is distinct from 'object' or jsonb_typeof(p_candidates) is distinct from 'object'
    or jsonb_typeof(p_metadata_candidates) is distinct from 'object' or jsonb_typeof(p_diagnostics) is distinct from 'object' then
    raise exception 'invoice_canonical_input_invalid' using errcode='22023'; end if;
  incoming:=public.sps_invoice_state_decode(p_value);
  select * into current_row from public.app_state where key='sps_invoices' for update;
  if not found or current_row.version<>p_expected_version then
    applied:=false; outcome:=case when current_row.key is null then 'missing' else 'conflict' end;
    current_version:=current_row.version; changed_at:=current_row.updated_at; value:=current_row.value; return next; return;
  end if;
  old_rows:=public.sps_invoice_state_decode(current_row.value);
  if exists(select 1 from jsonb_array_elements(incoming) e where jsonb_typeof(e)='object' and nullif(e->>'id','') is not null group by e->>'id' having count(*)>1) then
    raise exception 'invoice_authority_duplicate_identity' using errcode='22023'; end if;
  select coalesce(jsonb_object_agg(e->>'id',e),'{}'::jsonb) into incoming_index from jsonb_array_elements(incoming) e where jsonb_typeof(e)='object' and nullif(e->>'id','') is not null;
  select coalesce(jsonb_object_agg(e->>'id',e),'{}'::jsonb) into old_index from jsonb_array_elements(old_rows) e where jsonb_typeof(e)='object' and nullif(e->>'id','') is not null;
  for entry in select a.key,a.value from jsonb_each(p_authority) a loop
    if jsonb_typeof(entry.value) is distinct from 'object' or entry.value->>'id' is distinct from entry.key
      or nullif(btrim(entry.value->>'qbId'),'') is null or entry.value->'qbAuthoritative' is distinct from 'true'::jsonb
      or entry.value->>'qbSyncStatus' is distinct from 'synced' or entry.value->'locallyEdited'='true'::jsonb
      or entry.value->'qbPendingLocalEdits'='true'::jsonb or entry.value->'qbLocalChangesPending'='true'::jsonb
      or not incoming_index ? entry.key then
      raise exception 'invoice_canonical_authority_invalid' using errcode='22023'; end if;
    select * into anchor from public.sps_invoice_authority a where a.invoice_id=entry.key;
    if found and anchor.qb_id=entry.value->>'qbId' and coalesce(anchor.invoice->>'qbSyncToken','')~'^\d+$'
      and coalesce(entry.value->>'qbSyncToken','')~'^\d+$'
      and (anchor.invoice->>'qbSyncToken')::numeric>(entry.value->>'qbSyncToken')::numeric then
      raise exception 'invoice_canonical_stale_revision' using errcode='40001';
    end if;
    if exists(select 1 from public.sps_invoice_delete_authorizations d where d.consumed_at is not null
      and (d.invoice_id=entry.key or d.qb_id=entry.value->>'qbId')) then
      raise exception 'invoice_deleted_identity_reused' using errcode='40001';
    end if;
    if exists(select 1 from public.sps_invoice_authority a where a.invoice_id<>entry.key and a.qb_id=entry.value->>'qbId') then
      raise exception 'invoice_canonical_identity_conflict' using errcode='40001';
    end if;
  end loop;
  for entry in select d.key,d.value from jsonb_each(p_diagnostics) d loop
    if p_action<>'quickbooks-refresh' or p_authority ? entry.key or not incoming_index ? entry.key
      or old_index->entry.key is distinct from entry.value->'expected'
      or jsonb_typeof(entry.value->'patch') is distinct from 'object'
      or public.sps_invoice_financial_content(incoming_index->entry.key) is distinct from public.sps_invoice_financial_content(entry.value->'expected')
      or entry.value->'patch'->'qbNeedsReview' is distinct from 'true'::jsonb
      or coalesce(entry.value->'patch'->>'qbSyncStatus','') not in ('missing-remote','duplicate-local-qb-id')
      or exists(select 1 from jsonb_object_keys(entry.value->'patch') k where k not in ('qbNeedsReview','qbSyncStatus','qbMissingSince','qbDuplicateOfId'))
      or (entry.value->'patch'->>'qbSyncStatus'='missing-remote' and nullif(entry.value->'patch'->>'qbMissingSince','') is null)
      or (entry.value->'patch'->>'qbSyncStatus'='duplicate-local-qb-id' and not exists(
        select 1 from jsonb_each(incoming_index) i where i.key=entry.value->'patch'->>'qbDuplicateOfId' and i.key<>entry.key
          and nullif(i.value->>'qbId','')=nullif(entry.value->'expected'->>'qbId',''))) then
      raise exception 'invoice_canonical_diagnostic_changed' using errcode='40001';
    end if;
  end loop;
  for entry in select c.key,c.value from jsonb_each(p_candidates) c loop
    if not p_authority ? entry.key or old_index->entry.key is distinct from entry.value then
      raise exception 'invoice_canonical_candidate_changed' using errcode='40001'; end if;
  end loop;
  for entry in select c.key,c.value from jsonb_each(p_metadata_candidates) c loop
    if not p_authority ? entry.key or jsonb_typeof(entry.value->'proposed') is distinct from 'object'
      or entry.value->'proposed'->>'id' is distinct from entry.key
      or old_index->entry.key is distinct from entry.value->'expected'
      or public.sps_invoice_financial_content(entry.value->'proposed') is distinct from public.sps_invoice_financial_content(p_authority->entry.key) then
      raise exception 'invoice_canonical_metadata_candidate_changed' using errcode='40001'; end if;
  end loop;
  -- Do not expand the complete ledger once per authority row. Its exact id
  -- index already exists above. The separate IF also avoids evaluating this
  -- work for a changed ledger or a pending diagnostic/proposal.
  if incoming=old_rows and p_candidates='{}'::jsonb and p_metadata_candidates='{}'::jsonb and p_diagnostics='{}'::jsonb then
    if not exists (
      select 1 from jsonb_each(p_authority) a
      where case when a.value is not distinct from old_index->a.key then false
        else public.sps_invoice_protected_content(a.value) is distinct from public.sps_invoice_protected_content(old_index->a.key) end
    ) then
    for entry in select a.key,a.value from jsonb_each(p_authority) a loop
      perform public.sps_invoice_register_authority(entry.key,entry.value,p_action);
    end loop;
    applied:=true; outcome:='unchanged'; current_version:=current_row.version; changed_at:=current_row.updated_at; value:=current_row.value;
    return next; return;
    end if;
  end if;
  perform set_config('sps.invoice_canonical_write',jsonb_build_object('action',p_action,'actor',p_actor_id,'authority',p_authority,'candidates',p_candidates,'metadata_candidates',p_metadata_candidates,'diagnostics',p_diagnostics)::text,true);
  -- The nontrivial path runs the same record guard as ordinary writes while
  -- supplying independently verified authority for the exact named targets.
  update public.app_state a set value=p_value where a.key='sps_invoices' returning * into current_row;
  perform set_config('sps.invoice_canonical_write','',true);
  applied:=true; outcome:='updated'; current_version:=current_row.version; changed_at:=current_row.updated_at; value:=current_row.value;
  return next;
end $f$;

create or replace function public.sps_guard_invoice_authority() returns trigger
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare old_rows jsonb:='[]'; old_index jsonb:='{}'; incoming_ids jsonb:='{}'; incoming jsonb; output jsonb:='[]'; output_items jsonb[]:='{}'; item jsonb; previous jsonb; final_invoice jsonb; authority jsonb;
  context jsonb:='{}'; authority_index jsonb:='{}'; claims jsonb; trusted boolean:=false; actor text; action text; invoice_key text; marker jsonb; redirected_markers jsonb:='{}';
  known_stale boolean; exact_fee boolean; visible boolean; reason text; owner_key text; owner_invoice jsonb; entry record; anchor public.sps_invoice_authority%rowtype;
  authorized public.sps_invoice_delete_authorizations%rowtype;
begin
  if tg_op='DELETE' then
    if old.key='sps_invoices' then raise exception 'invoice_ledger_delete_requires_server' using errcode='42501'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.key<>new.key and (old.key='sps_invoices' or new.key='sps_invoices') then
    raise exception 'invoice_ledger_key_immutable' using errcode='42501';
  end if;
  if new.key<>'sps_invoices' then return new; end if;
  if tg_op='UPDATE' then old_rows:=public.sps_invoice_state_decode(old.value); end if;
  incoming:=public.sps_invoice_state_decode(new.value);
  claims:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}');
  if current_setting('role',true)='service_role' and coalesce(claims->>'role',current_setting('request.jwt.claim.role',true),'')='service_role' then
    context:=coalesce(nullif(current_setting('sps.invoice_canonical_write',true),'')::jsonb,'{}');
    trusted:=context->>'action' in ('quickbooks-refresh','quickbooks-create','quickbooks-update','quickbooks-payment','review','candidate-resolution');
  end if;
  -- Extract the large authority object once, not once for every invoice.
  if trusted then authority_index:=coalesce(context->'authority','{}'::jsonb); end if;
  actor:=coalesce(context->>'actor',claims->>'sub',auth.uid()::text,'unknown-device'); action:=context->>'action';
  if exists (select 1 from jsonb_array_elements(incoming) e where jsonb_typeof(e)='object' and nullif(e->>'id','') is not null group by e->>'id' having count(*)>1)
    then raise exception 'invoice_authority_duplicate_identity' using errcode='22023'; end if;
  select coalesce(jsonb_object_agg(e->>'id',e),'{}'::jsonb) into old_index from jsonb_array_elements(old_rows) e where jsonb_typeof(e)='object' and nullif(e->>'id','') is not null;
  select coalesce(jsonb_object_agg(e->>'id',true),'{}'::jsonb) into incoming_ids from jsonb_array_elements(incoming) e where jsonb_typeof(e)='object' and nullif(e->>'id','') is not null;

  for item in select value from jsonb_array_elements(incoming) loop
    if jsonb_typeof(item)<>'object' or nullif(item->>'id','') is null then output_items:=array_append(output_items,item); continue; end if;
    invoice_key:=item->>'id';
    previous:=old_index->invoice_key;
    select * into authorized from public.sps_invoice_delete_authorizations d where d.consumed_at is not null
      and (d.invoice_id=invoice_key or (d.qb_id is not null and d.qb_id=nullif(btrim(item->>'qbId'),''))) limit 1;
    if found then
      if trusted then raise exception 'invoice_deleted_identity_reused' using errcode='40001'; end if;
      perform public.sps_invoice_record_candidate(invoice_key,previous,item,authorized.expected_invoice,actor,'deleted-invoice-replay',false);
      continue;
    end if;
    authority:=case when trusted then authority_index->invoice_key end;
    if jsonb_typeof(authority)='object' then
      if action<>'review' and previous ? 'qbReviewResolution' then authority:=jsonb_set(authority,'{qbReviewResolution}',previous->'qbReviewResolution'); end if;
      -- Mixed refreshes retain exact rows without rebuilding all fields.
      -- Tombstone checks ran above; proposals and explicit reviews never use
      -- this shortcut. Register still seeds independently verified authority.
      if item is not distinct from previous and authority is not distinct from (item-'qbWriteReview')
        and action not in ('review','candidate-resolution')
        and not (coalesce(context->'candidates','{}'::jsonb) ? invoice_key)
        and not (coalesce(context->'metadata_candidates','{}'::jsonb) ? invoice_key) then
        perform public.sps_invoice_register_authority(invoice_key,item,action);
        output_items:=array_append(output_items,item); continue;
      end if;
      if previous is not null and (action='review' or (
        previous->'locallyEdited' is distinct from 'true'::jsonb and previous->'qbPendingLocalEdits' is distinct from 'true'::jsonb
        and previous->'qbLocalChangesPending' is distinct from 'true'::jsonb
      )) and not exists(select 1 from public.sps_invoice_authority_history h where h.invoice_id=invoice_key and h.invoice=previous) then
        insert into public.sps_invoice_authority_history(invoice_id,invoice,source) values(invoice_key,previous,'shared-before-'||action);
      end if;
      final_invoice:=public.sps_invoice_restore_authority(item,authority);
      marker:=previous->'qbWriteReview';
      -- Preserve an existing proposal until the owner resolves that exact invoice_key.
      if action in ('candidate-resolution','review') then marker:=item->'qbWriteReview'; end if;
      if action='quickbooks-refresh' and previous is not null and public.sps_invoice_financial_content(previous)<>public.sps_invoice_financial_content(authority)
        and (previous->'locallyEdited'='true'::jsonb or previous->'qbPendingLocalEdits'='true'::jsonb or previous->'qbLocalChangesPending'='true'::jsonb) then
        exact_fee:=public.sps_invoice_exact_legacy_fee(previous,authority) or exists(select 1 from public.sps_invoice_authority_history h where h.invoice_id=invoice_key and public.sps_invoice_exact_legacy_fee(previous,h.invoice));
        marker:=case when exact_fee then marker else public.sps_invoice_record_candidate(invoice_key,previous,previous,authority,actor,'unconfirmed-accounting-change',true) end;
        if exact_fee then perform public.sps_invoice_record_candidate(invoice_key,previous,previous,authority,actor,'legacy-automatic-late-fee',false); end if;
      end if;
      if context->'candidates' ? invoice_key and public.sps_invoice_financial_content(context->'candidates'->invoice_key)<>public.sps_invoice_financial_content(authority) then
        exact_fee:=public.sps_invoice_exact_legacy_fee(context->'candidates'->invoice_key,authority) or exists(
          select 1 from public.sps_invoice_authority_history h where h.invoice_id=invoice_key and public.sps_invoice_exact_legacy_fee(context->'candidates'->invoice_key,h.invoice));
        if exact_fee then perform public.sps_invoice_record_candidate(invoice_key,previous,context->'candidates'->invoice_key,authority,actor,'legacy-automatic-late-fee',false);
        else marker:=public.sps_invoice_record_candidate(invoice_key,previous,context->'candidates'->invoice_key,authority,actor,'unconfirmed-accounting-change',true); end if;
      end if;
      if context->'metadata_candidates' ? invoice_key then
        marker:=public.sps_invoice_record_candidate(invoice_key,previous,context->'metadata_candidates'->invoice_key->'proposed',authority,actor,'concurrent-sps-metadata',true);
      end if;
      if marker is not null and marker<>'null'::jsonb then final_invoice:=jsonb_set(final_invoice,'{qbWriteReview}',marker); end if;
      perform public.sps_invoice_register_authority(invoice_key,final_invoice,action);
      output_items:=array_append(output_items,final_invoice); continue;
    end if;

    select * into anchor from public.sps_invoice_authority a where a.invoice_id=invoice_key;
    if not found then
      select * into anchor from public.sps_invoice_authority a where a.qb_id=nullif(btrim(item->>'qbId'),'') order by a.invoice_id limit 1;
      if anchor.invoice_id is null and trusted then
        select a.key,a.value into owner_key,owner_invoice from jsonb_each(authority_index) a
          where a.key<>invoice_key and nullif(btrim(a.value->>'qbId'),'')=nullif(btrim(item->>'qbId'),'') order by a.key limit 1;
        if found then anchor.invoice_id:=owner_key; anchor.invoice:=owner_invoice; anchor.qb_id:=owner_invoice->>'qbId'; end if;
      end if;
      if anchor.invoice_id is not null then
        -- An existing duplicate can have visit/estimate references to its local
        -- id. Keep that review context; only a newly introduced alias is folded.
        if previous is not null and previous->>'qbId'=item->>'qbId' then
          final_invoice:=public.sps_invoice_restore_authority(item,previous)||jsonb_build_object(
            'qbNeedsReview',true,'qbSyncStatus','duplicate-local-qb-id','qbDuplicateOfId',anchor.invoice_id);
          if public.sps_invoice_financial_content(item)<>public.sps_invoice_financial_content(previous) then
            marker:=public.sps_invoice_record_candidate(anchor.invoice_id,anchor.invoice,item,anchor.invoice,actor,'duplicate-invoice-identity',true);
            redirected_markers:=jsonb_set(redirected_markers,array[anchor.invoice_id],marker);
          end if;
          output_items:=array_append(output_items,final_invoice); continue;
        end if;
        marker:=public.sps_invoice_record_candidate(anchor.invoice_id,anchor.invoice,item,anchor.invoice,actor,'duplicate-invoice-identity',true);
        redirected_markers:=jsonb_set(redirected_markers,array[anchor.invoice_id],marker);
        continue;
      end if;
      -- No browser flag can seed the authority table. The next fresh server QB
      -- pull or confirmed create/update supplies independently verified data.
      output_items:=array_append(output_items,item-'qbWriteReview'); continue;
    end if;
    -- Unchanged content already identical to its authority needs no repair.
    -- This is after deletion and alias checks, and accepts no new field.
    if item is not distinct from previous and (item-'qbWriteReview') is not distinct from anchor.invoice then
      output_items:=array_append(output_items,item); continue;
    end if;
    authority:=anchor.invoice;
    -- SPS-only resolutions keep their server receipt but remain editable and
    -- deletable as local invoices, without inventing a QuickBooks dependency.
    if anchor.qb_id is null then
      final_invoice:=item-'qbWriteReview';
      if authority ? 'qbReviewResolution' then final_invoice:=jsonb_set(final_invoice,'{qbReviewResolution}',authority->'qbReviewResolution'); end if;
      if previous ? 'qbWriteReview' then final_invoice:=jsonb_set(final_invoice,'{qbWriteReview}',previous->'qbWriteReview'); end if;
      output_items:=array_append(output_items,final_invoice); continue;
    end if;
    final_invoice:=public.sps_invoice_restore_authority(item,authority);
    -- An exact historical full record contains no new edit. Retain later SPS
    -- notes/costs as well as accounting when an old device replays that record.
    if previous is not null and item is distinct from previous and exists(
      select 1 from public.sps_invoice_authority_history h where h.invoice_id=invoice_key and h.invoice=item
    ) then final_invoice:=public.sps_invoice_restore_authority(previous,authority); end if;
    marker:=previous->'qbWriteReview';
    if public.sps_invoice_financial_content(item)<>public.sps_invoice_financial_content(authority) then
      known_stale:=exists(select 1 from public.sps_invoice_authority_history h where h.invoice_id=invoice_key and public.sps_invoice_protected_content(item)=public.sps_invoice_protected_content(h.invoice));
      exact_fee:=public.sps_invoice_exact_legacy_fee(item,authority) or exists(select 1 from public.sps_invoice_authority_history h where h.invoice_id=invoice_key and public.sps_invoice_exact_legacy_fee(item,h.invoice));
      visible:=not known_stale and not exact_fee;
      reason:=case when exact_fee then 'legacy-automatic-late-fee' when known_stale then 'stale-accounting-replay' else 'unconfirmed-accounting-change' end;
      if visible then marker:=public.sps_invoice_record_candidate(invoice_key,previous,item,authority,actor,reason,true);
      else perform public.sps_invoice_record_candidate(invoice_key,previous,item,authority,actor,reason,false); end if;
    end if;
    if marker is not null and marker<>'null'::jsonb then final_invoice:=jsonb_set(final_invoice,'{qbWriteReview}',marker); end if;
    output_items:=array_append(output_items,final_invoice);
  end loop;

  -- Removing an accounting record needs the exact deletion receipt issued by
  -- the server after QuickBooks confirmed it. Unrelated records still commit.
  for previous in select e from jsonb_array_elements(old_rows) e where jsonb_typeof(e)='object' and nullif(e->>'id','') is not null loop
    invoice_key:=previous->>'id';
    if incoming_ids ? invoice_key then continue; end if;
    -- A legacy missing-QuickBooks invoice may never have acquired an
    -- authority anchor. Consume its exact confirmed deletion anyway so an old
    -- device cannot re-add it and a lost HTTP reply can be checked by receipt.
    select * into authorized from public.sps_invoice_delete_authorizations d where d.invoice_id=invoice_key and d.consumed_at is null and d.expected_invoice=previous;
    if found then
      update public.sps_invoice_delete_authorizations set consumed_at=clock_timestamp() where invoice_id=invoice_key;
      continue;
    end if;
    select * into anchor from public.sps_invoice_authority where invoice_id=invoice_key;
    if not found or anchor.qb_id is null then continue; end if;
    marker:=redirected_markers->invoice_key;
    if marker is null then marker:=public.sps_invoice_record_candidate(invoice_key,previous,null,anchor.invoice,actor,'unconfirmed-delete',true); end if;
    output_items:=array_append(output_items,jsonb_set(previous,'{qbWriteReview}',marker));
  end loop;
  output:=to_jsonb(output_items);
  if redirected_markers<>'{}'::jsonb then
    select coalesce(jsonb_agg(case when redirected_markers ? (e.value->>'id') then jsonb_set(e.value,'{qbWriteReview}',redirected_markers->(e.value->>'id')) else e.value end order by e.ordinality),'[]'::jsonb)
      into output from jsonb_array_elements(output) with ordinality e(value,ordinality);
  end if;
  if trusted and coalesce(context->'diagnostics','{}'::jsonb)<>'{}'::jsonb then
    select coalesce(jsonb_agg(case when context->'diagnostics' ? (e.value->>'id')
      then e.value||(context->'diagnostics'->(e.value->>'id')->'patch') else e.value end order by e.ordinality),'[]'::jsonb)
      into output from jsonb_array_elements(output) with ordinality e(value,ordinality);
    for entry in select e from jsonb_array_elements(output) e where context->'diagnostics' ? (e->>'id') loop
      -- Only an already anchored id gains durable diagnostic state. This does
      -- not bless an unanchored duplicate or any new accounting values.
      if exists(select 1 from public.sps_invoice_authority a where a.invoice_id=entry.e->>'id') then
        perform public.sps_invoice_register_authority(entry.e->>'id',entry.e,'quickbooks-diagnostic');
      end if;
    end loop;
  end if;
  if output is distinct from incoming then new.value:=public.sps_invoice_state_encode(output,new.value); end if;
  return new;
end $f$;


commit;
