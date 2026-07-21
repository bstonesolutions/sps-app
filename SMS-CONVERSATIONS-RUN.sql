begin;

do $migration$
begin
  if pg_catalog.to_regclass('public.sps_inbox') is null then
    raise exception 'Run SMS-INBOX-MIGRATION.sql before SMS-CONVERSATIONS-RUN.sql';
  end if;
end;
$migration$;

alter table public.sps_inbox
  add column if not exists sms_direction text,
  add column if not exists sms_line text,
  add column if not exists sms_peer_phone text,
  add column if not exists quo_message_id text,
  add column if not exists quo_conversation_id text,
  add column if not exists quo_phone_number_id text,
  add column if not exists sms_status text,
  add column if not exists sms_media jsonb not null default '[]'::jsonb,
  add column if not exists quo_contact_id text,
  add column if not exists sms_contact_name text,
  add column if not exists sms_contact_avatar_path text,
  add column if not exists sms_provider_created_at timestamptz;

comment on column public.sps_inbox.sms_direction is
  'SMS direction: incoming from a customer or outgoing from an SPS line.';
comment on column public.sps_inbox.sms_line is
  'Protected SPS sender or recipient line: automation or main.';
comment on column public.sps_inbox.sms_peer_phone is
  'Normalized E.164 customer number used to group a line-scoped conversation.';
comment on column public.sps_inbox.quo_message_id is
  'Quo provider message id. Unique when supplied by Quo.';
comment on column public.sps_inbox.quo_conversation_id is
  'Quo conversation id. Never trusted without sms_line and sms_peer_phone.';
comment on column public.sps_inbox.quo_phone_number_id is
  'Quo workspace phone-number resource id.';
comment on column public.sps_inbox.sms_status is
  'Provider delivery state or SPS test_redirected state.';
comment on column public.sps_inbox.sms_media is
  'Private Storage descriptors only; provider URLs and signed URLs are never persisted.';
comment on column public.sps_inbox.quo_contact_id is
  'Quo contact id observed on this message, when supplied by Quo.';
comment on column public.sps_inbox.sms_contact_name is
  'Contact display name snapshot; SPS client matching remains authoritative.';
comment on column public.sps_inbox.sms_contact_avatar_path is
  'Private sms-media object path for an observed contact avatar.';
comment on column public.sps_inbox.sms_provider_created_at is
  'Timestamp supplied by Quo for the message event.';

update public.sps_inbox
set
  sms_direction = case
    when pg_catalog.lower(COALESCE(NULLIF(sms_direction, ''), ai ->> 'smsDirection', 'incoming')) = 'outgoing'
      then 'outgoing'
    else 'incoming'
  end,
  sms_line = case
    when pg_catalog.lower(COALESCE(NULLIF(sms_line, ''), ai ->> 'quoLine', 'automation')) = 'main'
      then 'main'
    else 'automation'
  end,
  sms_peer_phone = COALESCE(
    NULLIF(sms_peer_phone, ''),
    NULLIF(ai ->> 'intendedPeer', ''),
    NULLIF(from_phone, '')
  ),
  sms_status = COALESCE(
    NULLIF(sms_status, ''),
    case
      when ai ->> 'testRedirected' = 'true' then 'test_redirected'
      when pg_catalog.lower(COALESCE(ai ->> 'smsDirection', 'incoming')) = 'outgoing' then 'accepted'
      else 'received'
    end
  )
where channel = 'sms';

do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.sps_inbox'::pg_catalog.regclass
      and conname = 'sps_inbox_sms_direction_valid'
  ) then
    alter table public.sps_inbox
      add constraint sps_inbox_sms_direction_valid
      check (
        channel <> 'sms'
        or (sms_direction is not null and sms_direction in ('incoming', 'outgoing'))
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.sps_inbox'::pg_catalog.regclass
      and conname = 'sps_inbox_sms_line_valid'
  ) then
    alter table public.sps_inbox
      add constraint sps_inbox_sms_line_valid
      check (
        channel <> 'sms'
        or (sms_line is not null and sms_line in ('automation', 'main'))
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.sps_inbox'::pg_catalog.regclass
      and conname = 'sps_inbox_sms_media_array'
  ) then
    alter table public.sps_inbox
      add constraint sps_inbox_sms_media_array
      check (pg_catalog.jsonb_typeof(sms_media) = 'array');
  end if;
end;
$constraints$;

create unique index if not exists sps_inbox_sms_quo_message_unique
  on public.sps_inbox (quo_message_id)
  where channel = 'sms' and quo_message_id is not null and quo_message_id <> '';

create index if not exists sps_inbox_sms_conversation_history
  on public.sps_inbox (sms_line, quo_conversation_id, created_at desc, id)
  where channel = 'sms' and quo_conversation_id is not null and quo_conversation_id <> '';

create index if not exists sps_inbox_sms_peer_history
  on public.sps_inbox (sms_line, sms_peer_phone, created_at desc, id)
  where channel = 'sms' and sms_peer_phone is not null and sms_peer_phone <> '';

create table if not exists public.sps_sms_contacts (
  phone text primary key,
  quo_contact_id text,
  contact_name text not null default '',
  avatar_path text not null default '',
  updated_at timestamptz not null default pg_catalog.now(),
  constraint sps_sms_contacts_phone_e164
    check (phone ~ '^\+[1-9][0-9]{7,14}$')
);

comment on table public.sps_sms_contacts is
  'Server-only Quo contact cache keyed by normalized phone number.';
comment on column public.sps_sms_contacts.avatar_path is
  'Private sms-media object path; never a provider or signed URL.';

create index if not exists sps_sms_contacts_quo_contact
  on public.sps_sms_contacts (quo_contact_id)
  where quo_contact_id is not null and quo_contact_id <> '';

alter table public.sps_inbox enable row level security;
alter table public.sps_sms_contacts enable row level security;

do $service_only$
declare
  protected_table text;
  existing_policy record;
begin
  foreach protected_table in array array['sps_inbox', 'sps_sms_contacts']
  loop
    for existing_policy in
      select policyname
      from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = protected_table
    loop
      execute pg_catalog.format(
        'drop policy if exists %I on public.%I',
        existing_policy.policyname,
        protected_table
      );
    end loop;

    execute pg_catalog.format(
      'revoke all on table public.%I from public, anon, authenticated',
      protected_table
    );
    execute pg_catalog.format(
      'grant all on table public.%I to service_role',
      protected_table
    );
  end loop;
end;
$service_only$;

insert into storage.buckets (id, name, public)
values ('sms-media', 'sms-media', false)
on conflict (id) do update
set public = false;

drop policy if exists "sms media authenticated read boundary" on storage.objects;
drop policy if exists "sms media authenticated upload boundary" on storage.objects;
drop policy if exists "sms media authenticated update boundary" on storage.objects;
drop policy if exists "sms media authenticated delete boundary" on storage.objects;
drop policy if exists "sms media anonymous read boundary" on storage.objects;
drop policy if exists "sms media anonymous upload boundary" on storage.objects;
drop policy if exists "sms media anonymous update boundary" on storage.objects;
drop policy if exists "sms media anonymous delete boundary" on storage.objects;

create policy "sms media authenticated read boundary"
on storage.objects
as restrictive
for select
to authenticated
using (bucket_id <> 'sms-media');

create policy "sms media authenticated upload boundary"
on storage.objects
as restrictive
for insert
to authenticated
with check (bucket_id <> 'sms-media');

create policy "sms media authenticated update boundary"
on storage.objects
as restrictive
for update
to authenticated
using (bucket_id <> 'sms-media')
with check (bucket_id <> 'sms-media');

create policy "sms media authenticated delete boundary"
on storage.objects
as restrictive
for delete
to authenticated
using (bucket_id <> 'sms-media');

create policy "sms media anonymous read boundary"
on storage.objects
as restrictive
for select
to anon
using (bucket_id <> 'sms-media');

create policy "sms media anonymous upload boundary"
on storage.objects
as restrictive
for insert
to anon
with check (bucket_id <> 'sms-media');

create policy "sms media anonymous update boundary"
on storage.objects
as restrictive
for update
to anon
using (bucket_id <> 'sms-media')
with check (bucket_id <> 'sms-media');

create policy "sms media anonymous delete boundary"
on storage.objects
as restrictive
for delete
to anon
using (bucket_id <> 'sms-media');

commit;

select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'sps_inbox'
  and column_name in (
    'sms_direction',
    'sms_line',
    'sms_peer_phone',
    'quo_message_id',
    'quo_conversation_id',
    'quo_phone_number_id',
    'sms_status',
    'sms_media',
    'quo_contact_id',
    'sms_contact_name',
    'sms_contact_avatar_path',
    'sms_provider_created_at'
  )
order by column_name;

select conname, pg_catalog.pg_get_constraintdef(oid) as definition
from pg_catalog.pg_constraint
where conrelid in (
  'public.sps_inbox'::pg_catalog.regclass,
  'public.sps_sms_contacts'::pg_catalog.regclass
)
  and conname like 'sps_%'
order by conname;

select indexname, indexdef
from pg_catalog.pg_indexes
where schemaname = 'public'
  and tablename in ('sps_inbox', 'sps_sms_contacts')
  and indexname like 'sps_%'
order by indexname;

select id, name, public
from storage.buckets
where id = 'sms-media';

select policyname, roles, cmd, permissive, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and policyname like 'sms media % boundary'
order by policyname;
