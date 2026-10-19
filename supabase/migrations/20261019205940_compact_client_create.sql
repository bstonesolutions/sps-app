-- Create one client from a compact profile and retain its identity before its
-- first scheduled stop. Only the authenticated server endpoint can call this.
begin;

create table if not exists public.sps_client_creation_registry (
  client_id text primary key,
  request_id text not null unique,
  requested_client jsonb not null,
  created_client jsonb not null,
  before_version bigint not null check (before_version > 0),
  created_version bigint not null check (created_version = before_version + 1),
  created_at timestamptz not null default clock_timestamp(),
  check (client_id = request_id)
);
alter table public.sps_client_creation_registry enable row level security;
revoke all on public.sps_client_creation_registry from public,anon,authenticated,service_role;

create or replace function public.sps_client_create(
  p_request_id text, p_client jsonb, p_allow_billing boolean default false
) returns table (
  applied boolean, replayed boolean, outcome text, client jsonb,
  before_version bigint, current_version bigint, request_id text, client_projection boolean
)
language plpgsql security definer set search_path=pg_catalog set row_security=off as $f$
declare
  profile jsonb := p_client; field record; map_field record; rate numeric;
  prior_request public.sps_client_creation_registry%rowtype;
  locked_version bigint; saved_version bigint; target jsonb; saved_client jsonb;
  raw_roster text; wire_template jsonb; wire_value jsonb; is_empty boolean; projection jsonb;
  old_context text := current_setting('sps.stop_report_write',true);
  string_keys text[] := array['id','name','address','street','city','state','zip','phone','email',
    'division','plan','planFreq','status','pondType','pondSize','poolType','poolSize',
    'seasonalType','seasonalSize','nextService','referralSource','referredBy','preferredDay','routeDay','notes'];
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'client_create_service_only' using errcode='42501';
  end if;
  if p_request_id is null or p_request_id !~ '^(client-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(profile) is distinct from 'object'
    or jsonb_typeof(profile->'id') is distinct from 'string'
    or profile->>'id' is distinct from p_request_id then
    raise exception 'client_create_identity_invalid' using errcode='22023';
  end if;
  if octet_length(profile::text)>32768 then raise exception 'client_create_profile_too_large' using errcode='22023'; end if;
  if jsonb_typeof(profile->'name') is distinct from 'string'
    or not coalesce(profile->>'name' ~ '[^[:space:]]',false)
    or length(profile->>'name')>200 then
    raise exception 'client_create_name_invalid' using errcode='22023';
  end if;
  profile := jsonb_set(profile,'{name}',to_jsonb(regexp_replace(profile->>'name','^[[:space:]]+|[[:space:]]+$','','g')));
  for field in select * from jsonb_each(profile) loop
    if field.key=any(string_keys) or field.key ~ '^[a-z][a-z0-9 _-]{0,39}(Type|Size)$' then
      if jsonb_typeof(field.value) is distinct from 'string' or length(field.value #>> '{}')>2000 then
        raise exception 'client_create_text_invalid' using errcode='22023';
      end if;
    elsif field.key in ('servicePond','servicePool','serviceSeasonal','preferredDayOverride')
      or field.key ~ '^service[A-Z][A-Za-z0-9 _-]{0,39}$' then
      if jsonb_typeof(field.value) is distinct from 'boolean' then
        raise exception 'client_create_boolean_invalid' using errcode='22023';
      end if;
    elsif field.key in ('history','equipment') then
      if field.value is distinct from '[]'::jsonb then
        raise exception 'client_create_protected_field' using errcode='22023';
      end if;
    elsif field.key='balance' then
      if field.value not in ('0'::jsonb,'"0"'::jsonb,'"0.00"'::jsonb,'"$0.00"'::jsonb) then
        raise exception 'client_create_protected_field' using errcode='22023';
      end if;
    elsif field.key in ('plans','planRates') then
      if jsonb_typeof(field.value) is distinct from 'object'
        or (select count(*) from jsonb_object_keys(field.value))>32 then
        raise exception 'client_create_plan_invalid' using errcode='22023';
      end if;
      for map_field in select * from jsonb_each(field.value) loop
        if length(map_field.key) not between 1 and 50
          or map_field.key in ('__proto__','constructor','prototype') then
          raise exception 'client_create_plan_invalid' using errcode='22023';
        end if;
        if field.key='plans' then
          if jsonb_typeof(map_field.value) is distinct from 'string' or length(map_field.value #>> '{}')>160 then
            raise exception 'client_create_plan_invalid' using errcode='22023';
          end if;
        else
          if length(map_field.value #>> '{}')>160 or jsonb_typeof(map_field.value) not in ('number','string')
            or (map_field.value #>> '{}') !~ '^(|[0-9]+([.][0-9]*)?|[.][0-9]+)$' then
            raise exception 'client_create_rate_invalid' using errcode='22023';
          end if;
          rate := coalesce(nullif(map_field.value #>> '{}',''),'0')::numeric;
          if rate<0 or rate>1000000000 then raise exception 'client_create_rate_invalid' using errcode='22023'; end if;
          if rate<>0 and not coalesce(p_allow_billing,false) then raise exception 'client_create_billing_forbidden' using errcode='42501'; end if;
        end if;
      end loop;
    elsif field.key='monthlyRate' then
      if length(field.value #>> '{}')>160 or jsonb_typeof(field.value) not in ('number','string')
        or (field.value #>> '{}') !~ '^(|[0-9]+([.][0-9]*)?|[.][0-9]+)$' then
        raise exception 'client_create_rate_invalid' using errcode='22023';
      end if;
      rate := coalesce(nullif(field.value #>> '{}',''),'0')::numeric;
      if rate<0 or rate>1000000000 then raise exception 'client_create_rate_invalid' using errcode='22023'; end if;
      if rate<>0 and not coalesce(p_allow_billing,false) then raise exception 'client_create_billing_forbidden' using errcode='42501'; end if;
    elsif field.key='autoInvoice' then
      if jsonb_typeof(field.value) is distinct from 'string'
        or field.value #>> '{}' not in ('','Off','Monthly','Bi-Weekly','Weekly') then
        raise exception 'client_create_auto_invoice_invalid' using errcode='22023';
      end if;
      if field.value #>> '{}' not in ('','Off') and not coalesce(p_allow_billing,false) then
        raise exception 'client_create_billing_forbidden' using errcode='42501';
      end if;
    else
      -- No history, receipts, accounting identity, paid/prepaid policy, documents,
      -- or arbitrary imported fields can be smuggled through a profile creation.
      raise exception 'client_create_protected_field' using errcode='22023';
    end if;
  end loop;
  profile := profile || jsonb_build_object('history','[]'::jsonb,'equipment','[]'::jsonb,'balance','$0.00',
    'status',coalesce(nullif(profile->>'status',''),'Active'));

  -- One row lock serializes all creators and legacy roster writers. No client
  -- payload, guessed version, or unrelated local pending edit is sent here.
  select a.version into locked_version from public.app_state a where a.key='sps_clients' for update;
  if not found then raise exception 'client_create_roster_missing' using errcode='22023'; end if;
  select * into prior_request from public.sps_client_creation_registry r where r.client_id=p_request_id;
  if found and prior_request.requested_client is distinct from profile then
    raise exception 'client_create_request_mismatch' using errcode='23505';
  end if;
  select public.sps_stop_client_target_wire(a.value,p_request_id,'') into target
    from public.app_state a where a.key='sps_clients';
  if prior_request.client_id is not null then
    if target->>'matches' is distinct from '1' then
      raise exception 'client_create_saved_client_missing' using errcode='22023';
    end if;
    -- Replaying days later must not return inline visit photos or replace a
    -- full local record with a reduced contact. Mark this bounded projection
    -- explicitly; current clients only use it to fill an absent display entry.
    projection:=jsonb_build_object('id',p_request_id,'name',target->'client'->'name');
    for field in select * from jsonb_each(target->'client') loop
      if field.key=any(string_keys) or field.key ~ '^[a-z][a-z0-9 _-]{0,39}(Type|Size)$' then
        if jsonb_typeof(field.value)='string' and length(field.value #>> '{}')<=2000 then
          if octet_length((projection||jsonb_build_object(field.key,field.value))::text)<=32768 then
            projection:=projection||jsonb_build_object(field.key,field.value);
          end if;
        end if;
      elsif field.key='preferredDayOverride' or field.key ~ '^service[A-Z][A-Za-z0-9 _-]{0,39}$' then
        if jsonb_typeof(field.value)='boolean' then projection:=projection||jsonb_build_object(field.key,field.value); end if;
      elsif field.key='plans' or (coalesce(p_allow_billing,false) and field.key in ('planRates','monthlyRate','autoInvoice')) then
        if octet_length((projection||jsonb_build_object(field.key,field.value))::text)<=32768 then
          projection:=projection||jsonb_build_object(field.key,field.value);
        end if;
      end if;
    end loop;
    applied:=false; replayed:=true; outcome:='replayed'; client:=projection; client_projection:=true;
    before_version:=locked_version; current_version:=locked_version; request_id:=p_request_id;
    return next; return;
  end if;
  if target->>'matches' is distinct from '0' then
    raise exception 'client_create_identity_exists' using errcode='23505';
  end if;
  target:=null;
  select public.sps_stop_state_json_text(a.value),public.sps_stop_state_wire_template(a.value)
    into raw_roster,wire_template from public.app_state a where a.key='sps_clients';
  if json_typeof(raw_roster::json) is distinct from 'array' then
    raise exception 'client_create_roster_invalid' using errcode='22023';
  end if;
  is_empty := json_array_length(raw_roster::json)=0;
  raw_roster := regexp_replace(raw_roster,'[[:space:]]+$','');
  raw_roster := left(raw_roster,length(raw_roster)-1)
    || case when is_empty then '' else ',' end || profile::text || ']';
  if jsonb_typeof(wire_template) is distinct from 'string' then wire_value:=raw_roster::jsonb;
  elsif left(ltrim(wire_template #>> '{}'),1)='"' then wire_value:=to_jsonb(to_jsonb(raw_roster)::text);
  else wire_value:=to_jsonb(raw_roster); end if;
  raw_roster:=null;
  -- A caller cannot borrow the compact stop RPC's bypass context. The normal
  -- accepted-report and identity guard always validates this roster append.
  perform set_config('sps.stop_report_write','',true);
  update public.app_state a set value=wire_value where a.key='sps_clients' and a.version=locked_version
    returning a.version into saved_version;
  wire_value:=null;
  if saved_version is distinct from locked_version+1 then
    raise exception 'client_create_version_invalid' using errcode='40001';
  end if;
  select public.sps_stop_client_target_wire(a.value,p_request_id,'') into target
    from public.app_state a where a.key='sps_clients';
  saved_client := target->'client';
  if target->>'matches' is distinct from '1' or saved_client is distinct from profile then
    raise exception 'client_create_confirmation_invalid' using errcode='40001';
  end if;
  insert into public.sps_client_creation_registry(client_id,request_id,requested_client,created_client,before_version,created_version)
    values(p_request_id,p_request_id,profile,saved_client,locked_version,saved_version);
  perform set_config('sps.stop_report_write',coalesce(old_context,''),true);
  applied:=true; replayed:=false; outcome:='created'; client:=saved_client; client_projection:=false;
  before_version:=locked_version; current_version:=saved_version; request_id:=p_request_id;
  return next;
end $f$;
alter function public.sps_client_create(text,jsonb,boolean) owner to postgres;
revoke all on function public.sps_client_create(text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.sps_client_create(text,jsonb,boolean) to service_role;

-- Registered client preservation is appended below. The report guard remains
-- the only generic-roster trigger, preserving its activation and lock behavior.

create or replace function public.sps_stop_guard_client_items(p_old jsonb, p_new jsonb, p_context jsonb)
returns setof jsonb language plpgsql security definer set search_path = pg_catalog as $f$
declare
  incoming jsonb; prior jsonb; item jsonb; prior_item jsonb; old_by_id jsonb; incoming_ids jsonb;
  history jsonb; old_history jsonb; client_id text; rid text; target text := p_context->>'receipt';
  mode text := p_context->>'mode'; old_clients jsonb := coalesce(p_old, '[]');
  schedule_value jsonb; scheduled_ids jsonb := '{}'; registered_ids jsonb := '{}';
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
  -- Consult the saved schedule only when a snapshot omits existing clients. Do
  -- not lock a second app_state row here: legacy writes enter with the client
  -- row already locked, while server batch writers own their sorted lock order.
  -- This covers references committed before the write, not a concurrently
  -- created stop whose client has never reached the server. New-client flows
  -- must still confirm the client save before allowing a stop to be scheduled.
  if exists (select 1 from jsonb_array_elements(old_clients) c
    where c->>'id' is not null and not incoming_ids ? (c->>'id')) then
    select coalesce(jsonb_object_agg(r.client_id,true),'{}') into registered_ids
      from public.sps_client_creation_registry r;
    select public.sps_stop_state_decode(a.value) into schedule_value
      from public.app_state a where a.key='sps_schedule';
    if schedule_value is not null then
      if jsonb_typeof(schedule_value) is distinct from 'array' then
        raise exception 'client_reference_schedule_invalid' using errcode='22023';
      end if;
      select coalesce(jsonb_object_agg(refs.client_id,true),'{}') into scheduled_ids
        from (
          select coalesce(s.value->>'clientId',s.value->>'id') as client_id
          from jsonb_array_elements(schedule_value) d
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(d->'stops')='array' then d->'stops' else '[]'::jsonb end
          ) s(value)
        ) refs where nullif(refs.client_id,'') is not null;
    end if;
  end if;
  for incoming in select value from jsonb_array_elements(p_new) loop
    client_id := incoming->>'id';
    prior := old_by_id->client_id;
    -- A blank label cannot be a useful rename. Keep the last saved name even
    -- when an older whole-roster writer omits it; all nonblank renames and
    -- unrelated incoming fields retain their ordinary save behavior.
    if jsonb_typeof(prior->'name')='string' and prior->>'name' ~ '[^[:space:]]'
      and (jsonb_typeof(incoming->'name') is distinct from 'string'
        or not coalesce(incoming->>'name' ~ '[^[:space:]]',false)) then
      incoming := jsonb_set(incoming,'{name}',prior->'name');
    end if;
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
  -- A stale roster cannot remove a compact-created identity, even before its
  -- first stop, or a client that the saved schedule still uses.
  -- Keep the existing accepted-report protection as an independent condition.
  -- Unregistered and unreferenced clients without accepted reports retain
  -- existing deletion behavior. Registered clients require a future explicit
  -- authorized deletion path; omission alone is not proof of deletion intent.
  for prior in select value from jsonb_array_elements(old_clients) loop
    if not coalesce(incoming_ids ? (prior->>'id'),false)
      and (coalesce(registered_ids ? (prior->>'id'),false)
        or coalesce(scheduled_ids ? (prior->>'id'),false)
        or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(prior->'history')='array' then prior->'history' else '[]'::jsonb end) h
        where nullif(h->>'completionReceiptId','') is not null
          and not (coalesce(target=h->>'completionReceiptId',false) and mode='reverse')
          and not exists (select 1 from public.sps_stop_report_reversals r where r.receipt_id=h->>'completionReceiptId'))) then
      return next prior;
    end if;
  end loop;
  return;
end $f$;
alter function public.sps_stop_guard_client_items(jsonb,jsonb,jsonb) owner to postgres;
revoke all on function public.sps_stop_guard_client_items(jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;
commit;
