-- `meeting_url` already exists on the live table (added out-of-band, without
-- a migration, by whatever created it) -- this records it so a fresh
-- environment or disaster-recovery restore from migrations actually matches
-- production instead of silently missing the column.
alter table public.todos add column if not exists meeting_url text;

alter table public.todos
  add constraint todos_meeting_url_check
  check (meeting_url is null or char_length(meeting_url) <= 2048) not valid;

alter table public.todos validate constraint todos_meeting_url_check;
