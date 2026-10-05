-- Reviews and their frozen accounting intents are written only by the owner-
-- authorized server endpoint. Even an owner browser cannot bypass its state machine.
-- Service-role CAS continues to use the existing explicit service-role branch.
begin;

do $$
begin
  if pg_catalog.to_regprocedure('public.sps_rls_app_state_target_allowed(text)') is null
    or pg_catalog.to_regprocedure('public.sps_rls_app_state_write_allowed(text,jsonb)') is null then
    raise exception 'Install the versioned SPS app_state authorization before billing reviews';
  end if;
end;
$$;

create or replace function public.sps_rls_app_state_target_allowed(p_key text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
set row_security = off
as $function$
  select coalesce(
    p_key <> 'sps_billing_reviews'
    and public.sps_rls_is_staff()
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

-- Reviews can contain frozen payer/contact details and audit records. Only the
-- owner API exposes them, rather than the broad staff app_state bootstrap.
drop policy if exists app_state_billing_reviews_private on public.app_state;
create policy app_state_billing_reviews_private on public.app_state
  as restrictive for select to authenticated
  using (key <> 'sps_billing_reviews');

commit;
