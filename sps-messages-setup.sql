-- ============================================================
-- Stone Property Solutions — Messages table
-- Run this in Supabase SQL Editor before deploying the update
-- ============================================================

create table if not exists sps_messages (
  id          bigserial primary key,
  client_id   text not null,
  sender      text not null check (sender in ('staff', 'client')),
  sender_name text not null default '',
  body        text not null,
  created_at  timestamptz default now(),
  read_at     timestamptz
);

-- Index for fast per-client queries
create index if not exists sps_messages_client_idx on sps_messages(client_id, created_at desc);

-- RLS
alter table sps_messages enable row level security;

drop policy if exists "messages read" on sps_messages;
create policy "messages read"
  on sps_messages for select
  to authenticated
  using (true);

drop policy if exists "messages insert" on sps_messages;
create policy "messages insert"
  on sps_messages for insert
  to authenticated
  with check (true);

drop policy if exists "messages update" on sps_messages;
create policy "messages update"
  on sps_messages for update
  to authenticated
  using (true);

-- Done.
