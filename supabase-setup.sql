-- ============================================================
-- Stone Property Solutions — Supabase setup (Step 1)
-- HOW TO RUN:
--   1. In Supabase, open the left sidebar → "SQL Editor"
--   2. Click "New query"
--   3. Paste EVERYTHING in this file
--   4. Click "Run" (bottom right)
-- You should see "Success. No rows returned." That's correct.
-- ============================================================

-- One table holds all of the app's saved data (clients, schedule,
-- invoices, team, branding, settings, etc.) as named sections.
-- This mirrors how the app already saves things, so the switch is clean.
create table if not exists app_state (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

-- Lock the table down so only signed-in users can touch it.
alter table app_state enable row level security;

-- Signed-in users can read the data. (Inside the app, each person's
-- role still controls what they actually see on screen.)
drop policy if exists "app_state read" on app_state;
create policy "app_state read"
  on app_state for select
  to authenticated
  using (true);

-- Signed-in users can save changes.
drop policy if exists "app_state insert" on app_state;
create policy "app_state insert"
  on app_state for insert
  to authenticated
  with check (true);

drop policy if exists "app_state update" on app_state;
create policy "app_state update"
  on app_state for update
  to authenticated
  using (true)
  with check (true);

-- Done. Next: turn on Email logins and create your owner account.
