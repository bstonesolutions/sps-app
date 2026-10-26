-- These are permanent application conflicts, not PostgreSQL serialization
-- failures. PostgREST 14 retries SQLSTATE 40001 internally without returning an
-- HTTP response, so one rejected save can continuously occupy the database.
-- PT409 rolls back the same transaction and returns the same message with HTTP
-- 409. Do not intercept or rewrite actual database serialization failures.
-- Reference: https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions
begin;

do $migration$
declare
  target record; signature regprocedure; definition text; old_raise text; new_raise text; name text;
begin
  for target in select * from (values
    ('public.sps_shared_state_patch_batch_cas(jsonb,jsonb,text)', array[
      'shared_deleted_identity_reused','shared_state_protected_change_rejected']),
    ('public.sps_invoice_canonical_cas(bigint,jsonb,text,text,jsonb,jsonb,jsonb,jsonb)', array[
      'invoice_canonical_stale_revision','invoice_deleted_identity_reused','invoice_canonical_identity_conflict',
      'invoice_canonical_diagnostic_changed','invoice_canonical_candidate_changed','invoice_canonical_metadata_candidate_changed']),
    ('public.sps_guard_invoice_authority()', array['invoice_deleted_identity_reused']),
    ('public.sps_invoice_review_patch(text,jsonb,jsonb,text,text)', array['invoice_review_candidate_transition_invalid']),
    ('public.sps_invoice_review_patch_internal(text,jsonb,jsonb,text,text)', array['invoice_review_save_unconfirmed']),
    ('public.sps_client_create(text,jsonb,boolean)', array['client_create_version_invalid','client_create_confirmation_invalid']),
    ('public.sps_stop_completion_delta_cas(jsonb,text,text,text,text)', array['stop_clients_update_not_applied'])
  ) as approved(signature_text,error_names) loop
    signature:=to_regprocedure(target.signature_text);
    -- These modules can be installed independently. Never broaden the search to
    -- other functions or rewrite a code based on the SQLSTATE alone.
    if signature is null then continue; end if;
    definition:=pg_get_functiondef(signature);
    foreach name in array target.error_names loop
      old_raise:=format('raise exception %L using errcode=%L',name,'40001');
      new_raise:=format('raise exception %L using errcode=%L',name,'PT409');
      if strpos(definition,old_raise)=0 and strpos(definition,new_raise)=0 then
        raise exception 'business_conflict_migration_source_changed:%:%',target.signature_text,name;
      end if;
      definition:=replace(definition,old_raise,new_raise);
    end loop;
    -- CREATE OR REPLACE retains the installed owner, execution grants, and all
    -- function behavior other than the explicitly named exception SQLSTATEs.
    execute definition;
  end loop;
end $migration$;

commit;
