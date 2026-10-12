-- Replace the target client in one ordered JSON aggregation. The previous
-- character-position loop repeatedly scanned all earlier UTF-8 photo text,
-- making late roster entries take tens of seconds to save.
-- Keep the existing helper contract, JSON semantics, wire depth, and permissions.
begin;
create or replace function public.sps_stop_replace_client_value(p_value jsonb,p_index integer,p_client jsonb,p_template jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $f$
declare raw_value text; replacement text; client_count bigint;
begin
  raw_value:=public.sps_stop_state_json_text(p_value);
  if json_typeof(raw_value::json)<>'array' then raise exception 'stop_mutation_state_invalid' using errcode='22023'; end if;
  if p_index is null or p_index<0 then raise exception 'stop_client_index_missing' using errcode='22023'; end if;
  select json_agg(case when ordinality-1=p_index then p_client::text::json else value end order by ordinality)::text,count(*)
    into replacement,client_count from json_array_elements(raw_value::json) with ordinality;
  raw_value:=null;
  if p_index>=client_count then raise exception 'stop_client_index_missing' using errcode='22023'; end if;
  if jsonb_typeof(p_template)<>'string' then return replacement::jsonb; end if;
  if left(ltrim(p_template #>> '{}'),1)='"' then return to_jsonb(to_jsonb(replacement)::text); end if;
  return to_jsonb(replacement);
end $f$;

alter function public.sps_stop_replace_client_value(jsonb,integer,jsonb,jsonb) owner to postgres;
revoke all on function public.sps_stop_replace_client_value(jsonb,integer,jsonb,jsonb) from public,anon,authenticated,service_role;
commit;
