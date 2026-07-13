-- SPS Way inbound texting — additive inbox columns only.
--
-- Safe to run before the deferred RLS/security migrations:
--   * does not change policies, grants, app_state, clients, schedules, invoices, or inventory
--   * keeps every existing inbox row as an email
--   * is idempotent, so re-running it is harmless

begin;

alter table public.sps_inbox
  add column if not exists channel text not null default 'email',
  add column if not exists from_phone text not null default '';

comment on column public.sps_inbox.channel is
  'Inbound channel: email for forwarded mail, sms for Quo text-message webhooks.';

comment on column public.sps_inbox.from_phone is
  'Normalized sender phone for inbound SMS rows; blank for email rows.';

commit;

-- The result should show both rows with is_nullable = NO.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'sps_inbox'
  and column_name in ('channel', 'from_phone')
order by column_name;
