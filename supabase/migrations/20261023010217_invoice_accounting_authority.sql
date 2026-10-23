-- A confirmed accounting snapshot is independent of a device's whole-ledger
-- JSON. Generic writes retain that snapshot and journal competing intent.
-- Only server-only RPCs that consumed fresh QuickBooks evidence establish it.
begin;

create table public.sps_invoice_authority (
  invoice_id text primary key,
  qb_id text,
  invoice jsonb not null check (jsonb_typeof(invoice)='object'),
  revision bigint not null default 1,
  source text not null,
  confirmed_at timestamptz not null default clock_timestamp()
);
create index sps_invoice_authority_qb_id on public.sps_invoice_authority(qb_id) where qb_id is not null;
create table public.sps_invoice_authority_history (
  id bigint generated always as identity primary key,
  invoice_id text not null,
  invoice jsonb not null,
  source text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index sps_invoice_authority_history_invoice on public.sps_invoice_authority_history(invoice_id);
create table public.sps_invoice_write_candidates (
  id bigint generated always as identity primary key,
  invoice_id text not null,
  actor_id text not null,
  reason text not null,
  before_invoice jsonb,
  candidate_invoice jsonb,
  authority_invoice jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolution text
);
create index sps_invoice_write_candidates_pending on public.sps_invoice_write_candidates(invoice_id,id) where resolved_at is null;
create table public.sps_invoice_delete_authorizations (
  invoice_id text primary key,
  qb_id text,
  expected_invoice jsonb not null,
  actor_id text not null,
  authorized_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz
);
create index sps_invoice_deleted_qb_id on public.sps_invoice_delete_authorizations(qb_id) where consumed_at is not null;

alter table public.sps_invoice_authority enable row level security;
alter table public.sps_invoice_authority_history enable row level security;
alter table public.sps_invoice_write_candidates enable row level security;
alter table public.sps_invoice_delete_authorizations enable row level security;
revoke all on public.sps_invoice_authority,public.sps_invoice_authority_history,
  public.sps_invoice_write_candidates,public.sps_invoice_delete_authorizations from public,anon,authenticated,service_role;
revoke all on sequence public.sps_invoice_authority_history_id_seq,public.sps_invoice_write_candidates_id_seq from public,anon,authenticated,service_role;

create function public.sps_invoice_state_decode(p_value jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $f$
declare v jsonb:=p_value; depth integer:=0;
begin
  while jsonb_typeof(v)='string' and depth<2 loop v:=(v#>>'{}')::jsonb; depth:=depth+1; end loop;
  if jsonb_typeof(v) is distinct from 'array' then raise exception 'invoice_authority_state_invalid' using errcode='22023'; end if;
  return v;
end $f$;
create function public.sps_invoice_state_encode(p_value jsonb,p_template jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $f$
declare t jsonb:=p_template; v jsonb:=p_value; depth integer:=0; i integer;
begin
  while jsonb_typeof(t)='string' and depth<2 loop t:=(t#>>'{}')::jsonb; depth:=depth+1; end loop;
  for i in 1..depth loop v:=to_jsonb(v::text); end loop;
  return v;
end $f$;

create function public.sps_invoice_protected_key(k text) returns boolean
language sql immutable set search_path=pg_catalog as $f$
  select left(k,2)='qb' or k=any(array['number','clientId','clientName','date','issueDate','dueDate','sentDate','paidDate','status',
    'taxRate','taxAmount','discountType','discount','invoiceDiscountType','invoiceDiscount','subTotal','subtotal','total','balance',
    'items','lines','lineItems','partial','lateFeeAppliedAt','locallyEdited']);
$f$;
-- SPS costing/provenance and stable local line ids do not change a charge.
create function public.sps_invoice_financial_content(p_invoice jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $f$
declare result jsonb; lines jsonb;
begin
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into result from jsonb_each(p_invoice)
    where key=any(array['qbId','qbCustomerId','number','clientId','clientName','date','issueDate','dueDate','sentDate','paidDate','status',
      'taxRate','taxAmount','discountType','discount','invoiceDiscountType','invoiceDiscount','subTotal','subtotal','total','balance',
      'items','lines','partial','lateFeeAppliedAt']);
  if p_invoice ? 'lineItems' then
    if jsonb_typeof(p_invoice->'lineItems')='array' then
      select coalesce(jsonb_agg(case when jsonb_typeof(e.value)='object' then e.value-array['id','unitCost','costKnown','knownUnitCost','refId',
        'bundleItems','bundleNote','chargeType','chargeLabel','sourceEstimateLineId','sourceVisitLineId','sourceStopId','sourceStopIds',
        'sourceCompletionReceiptId','sourceCompletionReceiptIds','serviceMonth','sourceVisitDates','maintenanceService'] else e.value end order by e.ordinality),'[]'::jsonb)
        into lines from jsonb_array_elements(p_invoice->'lineItems') with ordinality e(value,ordinality);
    else lines:=p_invoice->'lineItems'; end if;
    result:=jsonb_set(result,'{lineItems}',lines);
  end if;
  return result;
end $f$;
create function public.sps_invoice_protected_content(p_invoice jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $f$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(case when jsonb_typeof(p_invoice)='object' then p_invoice else '{}'::jsonb end)
 where public.sps_invoice_protected_key(key) and key<>'qbWriteReview';
$f$;

create function public.sps_invoice_restore_authority(p_candidate jsonb,p_authority jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $f$
declare result jsonb; field record; same_charges boolean;
begin
  same_charges:=public.sps_invoice_financial_content(p_candidate)=public.sps_invoice_financial_content(p_authority);
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into result from jsonb_each(p_candidate)
    where not public.sps_invoice_protected_key(key);
  for field in select key,value from jsonb_each(p_authority) where public.sps_invoice_protected_key(key) and key<>'qbWriteReview' loop
    result:=jsonb_set(result,array[field.key],field.value);
  end loop;
  -- A cost-only/provenance edit is compatible with unchanged customer charges.
  if same_charges and p_candidate ? 'lineItems' then result:=jsonb_set(result,'{lineItems}',p_candidate->'lineItems'); end if;
  return result;
end $f$;

create function public.sps_invoice_exact_legacy_fee(p_candidate jsonb,p_reference jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $f$
declare lines jsonb:=p_candidate->'lineItems'; fee jsonb; date_text text:=p_candidate->>'lateFeeAppliedAt'; stripped jsonb;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines)<2 or coalesce(date_text,'')!~'^\d{4}-\d{2}-\d{2}$' then return false; end if;
  fee:=lines->(jsonb_array_length(lines)-1);
  if jsonb_typeof(fee) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(fee))<>8
    or not fee ?& array['id','desc','qty','unitPrice','amount','taxable','isLateFee','kind']
    or fee->>'id' is distinct from 'lf_'||(p_candidate->>'id')||'_'||date_text
    or fee->'qty' is distinct from '"1"'::jsonb or fee->'taxable' is distinct from 'false'::jsonb
    or fee->'isLateFee' is distinct from 'true'::jsonb or fee->>'kind' is distinct from 'lateFee'
    or nullif(btrim(fee->>'desc'),'') is null or coalesce(fee->>'unitPrice','')!~'^\d+\.\d{2}$'
    or jsonb_typeof(fee->'amount') is distinct from 'number' then return false; end if;
  if (fee->>'unitPrice')::numeric<=0 or (fee->>'unitPrice')::numeric<>(fee->>'amount')::numeric then return false; end if;
  stripped:=jsonb_set(p_candidate-'lateFeeAppliedAt','{lineItems}',lines-(jsonb_array_length(lines)-1));
  return public.sps_invoice_financial_content(stripped)=public.sps_invoice_financial_content(p_reference);
end $f$;

create function public.sps_invoice_record_candidate(p_id text,p_before jsonb,p_candidate jsonb,p_authority jsonb,p_actor text,p_reason text,p_visible boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare saved public.sps_invoice_write_candidates%rowtype;
begin
  select * into saved from public.sps_invoice_write_candidates c where c.invoice_id=p_id and c.reason=p_reason
    and c.candidate_invoice is not distinct from p_candidate
    and (c.resolved_at is null or (not p_visible and c.resolution='known-stale-write-preserved')) order by c.id desc limit 1;
  if not found then
    insert into public.sps_invoice_write_candidates(invoice_id,actor_id,reason,before_invoice,candidate_invoice,authority_invoice,resolved_at,resolution)
      values(p_id,coalesce(nullif(p_actor,''),'unknown-device'),p_reason,p_before,p_candidate,p_authority,
        case when not p_visible then clock_timestamp() end,case when not p_visible then 'known-stale-write-preserved' end)
      returning * into saved;
  end if;
  return jsonb_build_object('candidateId',saved.id::text,'reason',p_reason,'savedAt',saved.created_at);
end $f$;

create function public.sps_invoice_register_authority(p_id text,p_invoice jsonb,p_source text) returns void
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare previous public.sps_invoice_authority%rowtype;
begin
  select * into previous from public.sps_invoice_authority where invoice_id=p_id;
  if found and public.sps_invoice_protected_content(previous.invoice)=public.sps_invoice_protected_content(p_invoice) then return; end if;
  insert into public.sps_invoice_authority_history(invoice_id,invoice,source) values(p_id,p_invoice,p_source);
  insert into public.sps_invoice_authority(invoice_id,qb_id,invoice,source) values(p_id,nullif(btrim(p_invoice->>'qbId'),''),p_invoice-'qbWriteReview',p_source)
    on conflict(invoice_id) do update set qb_id=excluded.qb_id,invoice=excluded.invoice,source=excluded.source,
      revision=public.sps_invoice_authority.revision+1,confirmed_at=clock_timestamp();
end $f$;

-- Seed only evidence written by the already deployed service-only review RPC.
-- A browser's qbAuthoritative boolean is never enough to grant authority.
insert into public.sps_invoice_authority_history(invoice_id,invoice,source)
  select invoice_id,before_invoice,'review-before' from public.sps_invoice_review_audit;
insert into public.sps_invoice_authority_history(invoice_id,invoice,source)
  select invoice_id,after_invoice,'review-confirmed' from public.sps_invoice_review_audit;
insert into public.sps_invoice_authority(invoice_id,qb_id,invoice,source)
  select a.invoice_id,nullif(btrim(a.after_invoice->>'qbId'),''),a.after_invoice,'review-confirmed'
  from (select distinct on (invoice_id) * from public.sps_invoice_review_audit order by invoice_id,id desc) a
  where exists(select 1 from public.app_state s cross join lateral jsonb_array_elements(public.sps_invoice_state_decode(s.value)) e
    where s.key='sps_invoices' and e->>'id'=a.invoice_id
    and public.sps_invoice_protected_content(e)=public.sps_invoice_protected_content(a.after_invoice));

create function public.sps_guard_invoice_authority() returns trigger
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare old_rows jsonb:='[]'; old_index jsonb:='{}'; incoming_ids jsonb:='{}'; incoming jsonb; output jsonb:='[]'; output_items jsonb[]:='{}'; item jsonb; previous jsonb; final_invoice jsonb; authority jsonb;
  context jsonb:='{}'; claims jsonb; trusted boolean:=false; actor text; action text; invoice_key text; marker jsonb; redirected_markers jsonb:='{}';
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
    authority:=case when trusted then context->'authority'->invoice_key end;
    if jsonb_typeof(authority)='object' then
      if action<>'review' and previous ? 'qbReviewResolution' then authority:=jsonb_set(authority,'{qbReviewResolution}',previous->'qbReviewResolution'); end if;
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
        select a.key,a.value into owner_key,owner_invoice from jsonb_each(coalesce(context->'authority','{}'::jsonb)) a
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
    select * into anchor from public.sps_invoice_authority where invoice_id=invoice_key;
    if not found or anchor.qb_id is null then continue; end if;
    select * into authorized from public.sps_invoice_delete_authorizations d where d.invoice_id=invoice_key and d.consumed_at is null and d.expected_invoice=previous;
    if found then
      update public.sps_invoice_delete_authorizations set consumed_at=clock_timestamp() where invoice_id=invoice_key;
      continue;
    end if;
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

create trigger sps_guard_invoice_authority before insert or update or delete on public.app_state
for each row execute function public.sps_guard_invoice_authority();

create function public.sps_invoice_canonical_cas(p_expected_version bigint,p_value jsonb,p_actor_id text,p_action text,
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
  if incoming=old_rows and p_candidates='{}'::jsonb and p_metadata_candidates='{}'::jsonb and p_diagnostics='{}'::jsonb and not exists (
    select 1 from jsonb_each(p_authority) a join jsonb_array_elements(old_rows) e on e->>'id'=a.key
    where public.sps_invoice_protected_content(a.value)<>public.sps_invoice_protected_content(e)
  ) then
    for entry in select a.key,a.value from jsonb_each(p_authority) a loop
      perform public.sps_invoice_register_authority(entry.key,entry.value,p_action);
    end loop;
    applied:=true; outcome:='unchanged'; current_version:=current_row.version; changed_at:=current_row.updated_at; value:=current_row.value;
    return next; return;
  end if;
  perform set_config('sps.invoice_canonical_write',jsonb_build_object('action',p_action,'actor',p_actor_id,'authority',p_authority,'candidates',p_candidates,'metadata_candidates',p_metadata_candidates,'diagnostics',p_diagnostics)::text,true);
  -- The nontrivial path runs the same record guard as ordinary writes while
  -- supplying independently verified authority for the exact named targets.
  update public.app_state a set value=p_value where a.key='sps_invoices' returning * into current_row;
  perform set_config('sps.invoice_canonical_write','',true);
  applied:=true; outcome:='updated'; current_version:=current_row.version; changed_at:=current_row.updated_at; value:=current_row.value;
  return next;
end $f$;

create function public.sps_invoice_authority_owners() returns table(invoice_id text,qb_id text)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare claims jsonb;
begin
  claims:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}');
  if current_setting('role',true) is distinct from 'service_role' or coalesce(claims->>'role',current_setting('request.jwt.claim.role',true),'')<>'service_role' then
    raise exception 'invoice_canonical_service_only' using errcode='42501'; end if;
  return query select a.invoice_id,a.qb_id from public.sps_invoice_authority a where a.qb_id is not null order by a.invoice_id;
end $f$;

create function public.sps_invoice_authorize_delete(p_invoice_id text,p_expected_invoice jsonb,p_actor_id text)
returns table(authorized boolean,outcome text)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare claims jsonb; rows jsonb; target jsonb; matches integer;
begin
  claims:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}');
  if current_setting('role',true) is distinct from 'service_role' or coalesce(claims->>'role',current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'invoice_canonical_service_only' using errcode='42501'; end if;
  if nullif(btrim(p_invoice_id),'') is null or nullif(btrim(p_actor_id),'') is null or jsonb_typeof(p_expected_invoice) is distinct from 'object'
    or p_expected_invoice->>'id' is distinct from p_invoice_id then raise exception 'invoice_delete_authorization_invalid' using errcode='22023'; end if;
  select public.sps_invoice_state_decode(value) into rows from public.app_state where key='sps_invoices' for update;
  select count(*),(jsonb_agg(e))->0 into matches,target from jsonb_array_elements(rows) e where e->>'id'=p_invoice_id;
  if matches<>1 or target is distinct from p_expected_invoice then authorized:=false; outcome:='target_changed'; return next; return; end if;
  insert into public.sps_invoice_delete_authorizations(invoice_id,qb_id,expected_invoice,actor_id)
    values(p_invoice_id,nullif(btrim(target->>'qbId'),''),target,p_actor_id)
    on conflict(invoice_id) do update set qb_id=excluded.qb_id,expected_invoice=excluded.expected_invoice,actor_id=excluded.actor_id,authorized_at=clock_timestamp(),consumed_at=null;
  authorized:=true; outcome:='authorized'; return next;
end $f$;

create function public.sps_invoice_write_candidates_read(p_invoice_id text,p_candidate_id bigint default null)
returns setof public.sps_invoice_write_candidates
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare claims jsonb;
begin
  claims:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}');
  if current_setting('role',true) is distinct from 'service_role' or coalesce(claims->>'role',current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'invoice_canonical_service_only' using errcode='42501'; end if;
  return query select * from public.sps_invoice_write_candidates c where c.invoice_id=p_invoice_id and c.resolved_at is null
    and (p_candidate_id is null or c.id=p_candidate_id) order by c.id desc limit 100;
end $f$;

create function public.sps_invoice_write_candidate_resolve(p_invoice_id text,p_candidate_id bigint,p_expected_invoice jsonb,p_actor_id text,p_resolution text)
returns table(applied boolean,outcome text,invoice jsonb,before_invoice jsonb,before_version bigint,current_version bigint)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare claims jsonb; row public.app_state%rowtype; rows jsonb; target jsonb; target_index integer; next_invoice jsonb; remaining public.sps_invoice_write_candidates%rowtype;
begin
  claims:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}');
  if current_setting('role',true) is distinct from 'service_role' or coalesce(claims->>'role',current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'invoice_canonical_service_only' using errcode='42501'; end if;
  if p_resolution is null or p_resolution not in ('kept-quickbooks','applied-to-quickbooks') or nullif(btrim(p_actor_id),'') is null then
    raise exception 'invoice_candidate_resolution_invalid' using errcode='22023'; end if;
  select * into row from public.app_state where key='sps_invoices' for update;
  rows:=public.sps_invoice_state_decode(row.value);
  select e.value,(e.ordinality-1)::integer into target,target_index from jsonb_array_elements(rows) with ordinality e(value,ordinality) where e.value->>'id'=p_invoice_id;
  before_version:=row.version; current_version:=row.version;
  if target is distinct from p_expected_invoice or target->'qbWriteReview'->>'candidateId' is distinct from p_candidate_id::text
    or not exists(select 1 from public.sps_invoice_write_candidates c where c.id=p_candidate_id and c.invoice_id=p_invoice_id and c.resolved_at is null) then
    applied:=false; outcome:='target_changed'; return next; return;
  end if;
  next_invoice:=target-'qbWriteReview';
  select * into remaining from public.sps_invoice_write_candidates c where c.invoice_id=p_invoice_id and c.id<>p_candidate_id and c.resolved_at is null order by c.id desc limit 1;
  if found then next_invoice:=jsonb_set(next_invoice,'{qbWriteReview}',jsonb_build_object('candidateId',remaining.id::text,'reason',remaining.reason,'savedAt',remaining.created_at)); end if;
  perform set_config('sps.invoice_canonical_write',jsonb_build_object('action','candidate-resolution','actor',p_actor_id,'authority',jsonb_build_object(p_invoice_id,next_invoice))::text,true);
  update public.app_state a set value=public.sps_invoice_state_encode(jsonb_set(rows,array[target_index::text],next_invoice),row.value)
    where a.key='sps_invoices' returning a.version into current_version;
  perform set_config('sps.invoice_canonical_write','',true);
  update public.sps_invoice_write_candidates set resolved_at=clock_timestamp(),resolution=p_resolution where id=p_candidate_id;
  applied:=true; outcome:='applied'; invoice:=next_invoice; before_invoice:=target; return next;
end $f$;

-- Preserve the deployed review contract and its exact-target/hash guarantees.
-- Its internal implementation remains inaccessible even to service callers.
alter function public.sps_invoice_review_patch(text,jsonb,jsonb,text,text) rename to sps_invoice_review_patch_internal;
revoke all on function public.sps_invoice_review_patch_internal(text,jsonb,jsonb,text,text) from public,anon,authenticated,service_role;
create function public.sps_invoice_review_patch(p_invoice_id text,p_expected_invoice jsonb,p_invoice jsonb,p_actor_id text,p_action text)
returns table(applied boolean,outcome text,invoice jsonb,before_invoice jsonb,before_version bigint,current_version bigint)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare claims jsonb; result record; rows jsonb; target jsonb; expected_candidate_id text; next_marker jsonb; pending public.sps_invoice_write_candidates%rowtype; resolve_candidate boolean:=false;
begin
  claims:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}');
  if current_setting('role',true) is distinct from 'service_role' or coalesce(claims->>'role',current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'invoice_review_service_only' using errcode='42501'; end if;
  -- Plan/promote the marker in JS before its result hash is calculated. Verify
  -- that exact plan under the same invoice lock, then resolve the captured
  -- candidate in this transaction without changing the hashed result in SQL.
  expected_candidate_id:=p_expected_invoice->'qbWriteReview'->>'candidateId';
  if p_action in ('retry-linked','match-remote') and expected_candidate_id is not null then
    select public.sps_invoice_state_decode(a.value) into rows from public.app_state a where a.key='sps_invoices' for update;
    select e into target from jsonb_array_elements(rows) e where e->>'id'=p_invoice_id;
    if target=p_expected_invoice then
      if expected_candidate_id!~'^[1-9][0-9]{0,18}$' or not exists(select 1 from public.sps_invoice_write_candidates c
        where c.invoice_id=p_invoice_id and c.id::text=expected_candidate_id and c.resolved_at is null) then
        raise exception 'invoice_review_candidate_transition_invalid' using errcode='40001'; end if;
      select * into pending from public.sps_invoice_write_candidates c where c.invoice_id=p_invoice_id and c.id::text<>expected_candidate_id and c.resolved_at is null order by c.id desc limit 1;
      if found then
        next_marker:=p_invoice->'qbWriteReview';
        if jsonb_typeof(next_marker) is distinct from 'object' or next_marker->>'candidateId' is distinct from pending.id::text
          or next_marker->>'reason' is distinct from pending.reason or nullif(next_marker->>'savedAt','') is null
          or (next_marker->>'savedAt')::timestamptz is distinct from pending.created_at then
          raise exception 'invoice_review_candidate_transition_invalid' using errcode='40001'; end if;
      elsif p_invoice ? 'qbWriteReview' then raise exception 'invoice_review_candidate_transition_invalid' using errcode='40001'; end if;
      resolve_candidate:=true;
    end if;
  end if;
  perform set_config('sps.invoice_canonical_write',jsonb_build_object('action','review','actor',p_actor_id,'authority',jsonb_build_object(p_invoice_id,p_invoice))::text,true);
  select * into result from public.sps_invoice_review_patch_internal(p_invoice_id,p_expected_invoice,p_invoice,p_actor_id,p_action);
  perform set_config('sps.invoice_canonical_write','',true);
  if result.outcome in ('applied','unchanged') then perform public.sps_invoice_register_authority(p_invoice_id,p_invoice,'review'); end if;
  if resolve_candidate and result.outcome in ('applied','unchanged') then
    update public.sps_invoice_write_candidates c set resolved_at=clock_timestamp(),resolution='kept-quickbooks' where c.invoice_id=p_invoice_id and c.id::text=expected_candidate_id and c.resolved_at is null;
  end if;
  return query select result.applied,result.outcome,result.invoice,result.before_invoice,result.before_version,result.current_version;
end $f$;

-- Every private helper starts with PostgreSQL's PUBLIC execute default revoked.
do $grants$
declare f record;
begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
   and (p.proname in ('sps_guard_invoice_authority') or p.proname like 'sps_invoice_%') loop
   execute format('alter function %s owner to postgres',f.signature);
   execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $grants$;
grant execute on function public.sps_invoice_canonical_cas(bigint,jsonb,text,text,jsonb,jsonb,jsonb,jsonb),public.sps_invoice_authority_owners(),
  public.sps_invoice_authorize_delete(text,jsonb,text),public.sps_invoice_write_candidates_read(text,bigint),
  public.sps_invoice_write_candidate_resolve(text,bigint,jsonb,text,text),public.sps_invoice_review_patch(text,jsonb,jsonb,text,text) to service_role;
commit;
