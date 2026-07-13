-- SPS Way: private customer media Storage rollout
--
-- Run this in the Supabase SQL editor after SECURITY-RLS-MIGRATION.sql. The app stores
-- durable `sps-storage://client-media/...` locators and resolves them to short-lived
-- signed URLs, so the bucket must not remain public.
--
-- This migration is deliberately idempotent. It aborts before changing the bucket if
-- it finds an obvious older anon/public/authenticated policy that would still expose or mutate objects.
-- Restrictive boundary policies below are the final fail-closed layer: unlike ordinary permissive
-- policies, they cannot be bypassed by an overlooked broad policy being ORed with the staff rules.

begin;

do $migration$
begin
  if pg_catalog.to_regprocedure('public.sps_rls_is_staff()') is null
    or pg_catalog.to_regprocedure('public.sps_rls_is_owner()') is null
  then
    raise exception 'Run SECURITY-RLS-MIGRATION.sql before the media Storage migration';
  end if;
end;
$migration$;

-- Do not silently layer private policies on top of a permissive legacy policy. PostgreSQL
-- combines permissive RLS policies with OR, so one old `true` policy would defeat the new rules.
do $migration$
declare
  risky_policies text;
begin
  select pg_catalog.string_agg(pg_catalog.quote_ident(policyname), ', ' order by policyname)
    into risky_policies
  from pg_catalog.pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and ('anon' = any (roles) or 'public' = any (roles) or 'authenticated' = any (roles))
    and policyname not in (
      'client media staff read',
      'client media staff upload',
      'client media staff update',
      'client media owner delete',
      'client media read boundary',
      'client media upload boundary',
      'client media update boundary',
      'client media delete boundary',
      'client media anonymous read boundary',
      'client media anonymous upload boundary',
      'client media anonymous update boundary',
      'client media anonymous delete boundary'
    )
    and (
      pg_catalog.coalesce(qual, '') ilike '%client-media%'
      or pg_catalog.coalesce(with_check, '') ilike '%client-media%'
      or pg_catalog.btrim(pg_catalog.coalesce(qual, '')) in ('true', '(true)')
      or pg_catalog.btrim(pg_catalog.coalesce(with_check, '')) in ('true', '(true)')
      -- A role-only/global rule such as auth.role() = 'authenticated' does not name a
      -- bucket but still applies to client-media. Treat an absent bucket fence as broad.
      or (
        pg_catalog.upper(cmd) in ('ALL', 'SELECT', 'DELETE')
        and pg_catalog.coalesce(qual, '') not ilike '%bucket_id%'
      )
      or (
        pg_catalog.upper(cmd) = 'INSERT'
        and pg_catalog.coalesce(with_check, '') not ilike '%bucket_id%'
      )
      or (
        pg_catalog.upper(cmd) in ('ALL', 'UPDATE')
        -- PostgreSQL uses USING as the implicit WITH CHECK when WITH CHECK is omitted.
        and pg_catalog.coalesce(with_check, qual, '') not ilike '%bucket_id%'
      )
    );

  if risky_policies is not null then
    raise exception 'Remove or narrow these extra client-media Storage policies before retrying: %', risky_policies;
  end if;
end;
$migration$;

insert into storage.buckets (id, name, public)
values ('client-media', 'client-media', false)
on conflict (id) do update
set public = false;

drop policy if exists "client media staff read" on storage.objects;
drop policy if exists "client media staff upload" on storage.objects;
drop policy if exists "client media staff update" on storage.objects;
drop policy if exists "client media owner delete" on storage.objects;
drop policy if exists "client media read boundary" on storage.objects;
drop policy if exists "client media upload boundary" on storage.objects;
drop policy if exists "client media update boundary" on storage.objects;
drop policy if exists "client media delete boundary" on storage.objects;
drop policy if exists "client media anonymous read boundary" on storage.objects;
drop policy if exists "client media anonymous upload boundary" on storage.objects;
drop policy if exists "client media anonymous update boundary" on storage.objects;
drop policy if exists "client media anonymous delete boundary" on storage.objects;

-- Staff can create signed URLs and download existing customer media. Portal clients receive
-- signed URLs only after api/portal-data verifies that the media belongs to their client record.
create policy "client media staff read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'client-media'
  and public.sps_rls_is_staff()
);

create policy "client media staff upload"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'client-media'
  and (storage.foldername(name))[1] = 'media'
  and public.sps_rls_is_staff()
);

create policy "client media staff update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'client-media'
  and public.sps_rls_is_staff()
)
with check (
  bucket_id = 'client-media'
  and (storage.foldername(name))[1] = 'media'
  and public.sps_rls_is_staff()
);

create policy "client media owner delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'client-media'
  and public.sps_rls_is_owner()
);

-- PostgreSQL ORs permissive policies. These restrictive public-role boundaries are ANDed with
-- every applicable permissive policy, so even a legacy `using (true)`, role-only policy, or
-- complex bucket expression cannot grant a portal/anonymous caller client-media access. The
-- `bucket_id <> ...` side leaves every other Storage bucket's existing policy behavior unchanged.
create policy "client media read boundary"
on storage.objects
as restrictive
for select
to authenticated
using (
  bucket_id <> 'client-media'
  or public.sps_rls_is_staff()
);

create policy "client media upload boundary"
on storage.objects
as restrictive
for insert
to authenticated
with check (
  bucket_id <> 'client-media'
  or (
    (storage.foldername(name))[1] = 'media'
    and public.sps_rls_is_staff()
  )
);

create policy "client media update boundary"
on storage.objects
as restrictive
for update
to authenticated
using (
  bucket_id <> 'client-media'
  or public.sps_rls_is_staff()
)
with check (
  bucket_id <> 'client-media'
  or (
    (storage.foldername(name))[1] = 'media'
    and public.sps_rls_is_staff()
  )
);

create policy "client media delete boundary"
on storage.objects
as restrictive
for delete
to authenticated
using (
  bucket_id <> 'client-media'
  or public.sps_rls_is_owner()
);

-- Anonymous callers do not have EXECUTE on the staff-role helper functions. Separate boundaries
-- keep them away from client-media without invoking those helpers or disturbing other buckets.
create policy "client media anonymous read boundary"
on storage.objects
as restrictive
for select
to anon
using (bucket_id <> 'client-media');

create policy "client media anonymous upload boundary"
on storage.objects
as restrictive
for insert
to anon
with check (bucket_id <> 'client-media');

create policy "client media anonymous update boundary"
on storage.objects
as restrictive
for update
to anon
using (bucket_id <> 'client-media')
with check (bucket_id <> 'client-media');

create policy "client media anonymous delete boundary"
on storage.objects
as restrictive
for delete
to anon
using (bucket_id <> 'client-media');

commit;

-- Expected result: client-media is private, four permissive policies grant staff/owner access,
-- and authenticated + anonymous restrictive boundaries prevent any broader rule from OR-opening it.
select id, name, public
from storage.buckets
where id = 'client-media';

select policyname, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
order by policyname;
