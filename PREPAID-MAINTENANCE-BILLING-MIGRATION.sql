-- SPS Way: protect prepaid-maintenance accounting policy from ordinary staff writes.
-- Safe to run more than once after SECURITY-RLS-MIGRATION.sql.

begin;

create or replace function public.sps_rls_app_state_target_allowed(p_key text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
set row_security = off
as $function$
  select coalesce(
    public.sps_rls_is_staff()
    and (
      p_key not in (
        'sps_team', 'sps_email', 'sps_branding', 'sps_roles',
        'sps_budget', 'sps_costs', 'sps_invoicing', 'sps_schedule_cfg',
        'sps_maintenance_billing'
      )
      or public.sps_rls_is_owner()
    ),
    false
  );
$function$;

alter function public.sps_rls_app_state_target_allowed(text) owner to postgres;
revoke all on function public.sps_rls_app_state_target_allowed(text) from public, anon, authenticated;
grant execute on function public.sps_rls_app_state_target_allowed(text) to authenticated;

commit;

-- The SQL editor has no app JWT, so this verification result is expected to
-- be false. An authenticated owner is allowed by the function at runtime.
select public.sps_rls_app_state_target_allowed('sps_maintenance_billing') as maintenance_billing_write_allowed;
