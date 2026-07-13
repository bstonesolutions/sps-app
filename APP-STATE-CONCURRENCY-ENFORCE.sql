-- ============================================================================
-- SPS Way — app_state optimistic concurrency enforcement (stage two)
-- ============================================================================
-- Run only after every deployed browser/API writer uses sps_app_state_cas(),
-- sps_app_state_delete_cas(), or sps_app_state_batch_cas(), and old pending
-- whole-value writes are reconciled.
-- Safe to run again.
--
-- Authenticated staff retain RLS-protected reads but can no longer bypass CAS
-- with direct INSERT/UPDATE/DELETE. service_role access is intentionally kept
-- for server integrations; those writers must use CAS/version predicates too.
-- ============================================================================

begin;

do $preflight$
begin
  if pg_catalog.to_regprocedure(
    'public.sps_app_state_cas(text,bigint,jsonb)'
  ) is null or pg_catalog.to_regprocedure(
    'public.sps_app_state_delete_cas(text,bigint)'
  ) is null or pg_catalog.to_regprocedure(
    'public.sps_app_state_batch_cas(jsonb)'
  ) is null then
    raise exception
      'Run APP-STATE-CONCURRENCY-MIGRATION.sql before enforcing CAS';
  end if;
end;
$preflight$;

revoke insert, update, delete
  on table public.app_state
  from authenticated;

grant select
  on table public.app_state
  to authenticated;

-- Assert that the direct authenticated DML path really is closed.
do $assertion$
begin
  if pg_catalog.has_table_privilege(
    'authenticated', 'public.app_state', 'INSERT'
  ) or pg_catalog.has_table_privilege(
    'authenticated', 'public.app_state', 'UPDATE'
  ) or pg_catalog.has_table_privilege(
    'authenticated', 'public.app_state', 'DELETE'
  ) then
    raise exception 'CAS enforcement incomplete: authenticated DML remains';
  end if;
end;
$assertion$;

commit;
