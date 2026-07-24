-- SPS Way: private, per-staff text-conversation preferences.
--
-- Run this entire file in the Supabase SQL Editor. It is safe to run again.
-- Browser clients receive no direct table access; the authenticated staff API verifies the
-- current user and text-line permission before the service-role route reads or changes a pin.

begin;

create table if not exists public.sps_sms_thread_preferences (
  user_id uuid not null
    references auth.users (id) on delete cascade,
  thread_key text not null,
  pinned_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint sps_sms_thread_preferences_pkey
    primary key (user_id, thread_key),
  constraint sps_sms_thread_preferences_thread_key_valid
    check (
      pg_catalog.char_length(thread_key) between 1 and 240
      and thread_key ~ '^(automation|main)\|(phone:[0-9]{10}|quo:[A-Za-z0-9._:-]{1,160})$'
    )
);

comment on table public.sps_sms_thread_preferences is
  'Server-only personal text-conversation pins, isolated by authenticated staff user and SPS line.';
comment on column public.sps_sms_thread_preferences.user_id is
  'The verified Supabase auth.users id; never accepted from a browser request body.';
comment on column public.sps_sms_thread_preferences.thread_key is
  'Stable line-scoped conversation key derived by the server from an authorized SMS anchor.';

create index if not exists sps_sms_thread_preferences_user_pinned
  on public.sps_sms_thread_preferences (user_id, pinned_at desc);

alter table public.sps_sms_thread_preferences enable row level security;
alter table public.sps_sms_thread_preferences force row level security;

do $service_only$
declare
  existing_policy record;
begin
  for existing_policy in
    select policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'sps_sms_thread_preferences'
  loop
    execute pg_catalog.format(
      'drop policy if exists %I on public.sps_sms_thread_preferences',
      existing_policy.policyname
    );
  end loop;
end;
$service_only$;

revoke all on table public.sps_sms_thread_preferences
  from public, anon, authenticated;
grant select, insert, update, delete on table public.sps_sms_thread_preferences
  to service_role;

commit;

-- Verification: expect table_exists, rls_enabled, rls_forced, and service_role_access to be true;
-- policy_count and browser_role_grants must both be 0.
select
  pg_catalog.to_regclass('public.sps_sms_thread_preferences') is not null as table_exists,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  pg_catalog.has_table_privilege(
    'service_role',
    'public.sps_sms_thread_preferences',
    'select,insert,update,delete'
  ) as service_role_access
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'sps_sms_thread_preferences';

select pg_catalog.count(*) as policy_count
from pg_catalog.pg_policies
where schemaname = 'public'
  and tablename = 'sps_sms_thread_preferences';

select pg_catalog.count(*) as browser_role_grants
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'sps_sms_thread_preferences'
  and grantee in ('PUBLIC', 'anon', 'authenticated');
