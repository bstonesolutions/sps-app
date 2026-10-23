-- Staff-authorized API repairs exactly one invoice using current QuickBooks
-- evidence. This RPC accepts only the service role; clients cannot submit an
-- accounting replacement directly or inspect its private audit trail.
begin;

create table if not exists public.sps_invoice_review_audit (
  id bigint generated always as identity primary key,
  invoice_id text not null,
  actor_id text not null,
  action text not null check (action in ('retry-linked','match-remote','keep-sps-only')),
  before_invoice jsonb not null,
  after_invoice jsonb not null,
  before_version bigint not null check (before_version > 0),
  after_version bigint not null check (after_version = before_version + 1),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.sps_invoice_review_audit enable row level security;
revoke all on public.sps_invoice_review_audit from public,anon,authenticated,service_role;
revoke all on sequence public.sps_invoice_review_audit_id_seq from public,anon,authenticated,service_role;

create or replace function public.sps_invoice_review_patch(
  p_invoice_id text, p_expected_invoice jsonb, p_invoice jsonb, p_actor_id text, p_action text
) returns table (
  applied boolean, outcome text, invoice jsonb, before_invoice jsonb,
  before_version bigint, current_version bigint
)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare
  stored jsonb; decoded jsonb; next_value jsonb; saved jsonb; target jsonb;
  locked_version bigint; saved_version bigint; target_index integer; matches integer;
  depth integer := 0; i integer; new_qb_id text; claims jsonb;
begin
  claims := coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb);
  if coalesce(claims->>'role',current_setting('request.jwt.claim.role',true),'') <> 'service_role' then
    raise exception 'invoice_review_service_only' using errcode='42501';
  end if;
  if p_invoice_id is null or length(btrim(p_invoice_id)) not between 1 and 220
    or p_actor_id is null or length(btrim(p_actor_id)) not between 1 and 220
    or p_action is null or p_action not in ('retry-linked','match-remote','keep-sps-only')
    or jsonb_typeof(p_expected_invoice) is distinct from 'object'
    or jsonb_typeof(p_invoice) is distinct from 'object'
    or p_expected_invoice->>'id' is distinct from p_invoice_id
    or p_invoice->'id' is distinct from p_expected_invoice->'id'
    or octet_length(p_invoice::text)>2097152 then
    raise exception 'invoice_review_input_invalid' using errcode='22023';
  end if;

  -- Only the invoice row is locked. Unrelated client/history conflicts never
  -- prevent this operation, and unrelated invoice edits need no retry.
  select a.value,a.version into stored,locked_version from public.app_state a
    where a.key='sps_invoices' for update;
  if not found then
    applied:=false; outcome:='missing'; return next; return;
  end if;
  decoded:=stored;
  while jsonb_typeof(decoded)='string' and depth<2 loop
    decoded:=(decoded #>> '{}')::jsonb;
    depth:=depth+1;
  end loop;
  if jsonb_typeof(decoded) is distinct from 'array' then
    raise exception 'invoice_review_state_invalid' using errcode='22023';
  end if;
  select count(*)::integer,min((e.ordinality-1)::integer) into matches,target_index
    from jsonb_array_elements(decoded) with ordinality as e(item,ordinality)
    where jsonb_typeof(e.item)='object' and e.item->>'id'=p_invoice_id;
  before_version:=locked_version; current_version:=locked_version;
  if matches<>1 then
    applied:=false; outcome:=case when matches=0 then 'missing' else 'ambiguous' end;
    return next; return;
  end if;
  target:=decoded->target_index;
  if target is distinct from p_expected_invoice then
    applied:=false; outcome:='target_changed'; return next; return;
  end if;
  new_qb_id:=nullif(btrim(p_invoice->>'qbId'),'');
  if new_qb_id is not null and exists (
    select 1 from jsonb_array_elements(decoded) with ordinality e(item,ordinality)
    where e.ordinality-1<>target_index and nullif(btrim(e.item->>'qbId'),'')=new_qb_id
  ) then
    applied:=false; outcome:='duplicate_quickbooks_id'; return next; return;
  end if;
  if target=p_invoice then
    applied:=false; outcome:='unchanged'; invoice:=target; before_invoice:=target;
    return next; return;
  end if;

  -- Keep the original array order, primitive entries, and JSON string depth.
  -- jsonb_set modifies only the chosen element; every other value is preserved
  -- semantically, including fields this release does not understand.
  next_value:=jsonb_set(decoded,array[target_index::text],p_invoice,false);
  for i in 1..depth loop next_value:=to_jsonb(next_value::text); end loop;
  update public.app_state a set value=next_value where a.key='sps_invoices'
    and a.version=locked_version returning a.value,a.version into saved,saved_version;
  if saved_version is distinct from locked_version+1 or saved is distinct from next_value then
    raise exception 'invoice_review_save_unconfirmed' using errcode='40001';
  end if;
  insert into public.sps_invoice_review_audit(invoice_id,actor_id,action,before_invoice,after_invoice,before_version,after_version)
    values(p_invoice_id,p_actor_id,p_action,target,p_invoice,locked_version,saved_version);
  applied:=true; outcome:='applied'; invoice:=p_invoice; before_invoice:=target;
  before_version:=locked_version; current_version:=saved_version;
  return next;
end $f$;
alter function public.sps_invoice_review_patch(text,jsonb,jsonb,text,text) owner to postgres;
revoke all on function public.sps_invoice_review_patch(text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.sps_invoice_review_patch(text,jsonb,jsonb,text,text) to service_role;

commit;
