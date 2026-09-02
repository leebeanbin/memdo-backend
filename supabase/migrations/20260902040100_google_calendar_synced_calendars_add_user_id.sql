-- Denormalized, matching google_calendar_mirror_events' own connection_id +
-- user_id pairing -- lets every endpoint on this table do a direct, simple
-- `.eq('user_id', userId)` ownership check instead of an embedded join
-- through google_calendar_connections every time.
alter table public.google_calendar_synced_calendars
  add column user_id uuid references public.users(id) on delete cascade;

update public.google_calendar_synced_calendars sc
set user_id = gc.user_id
from public.google_calendar_connections gc
where gc.id = sc.connection_id;

alter table public.google_calendar_synced_calendars
  alter column user_id set not null;

create index google_calendar_synced_calendars_user_idx
on public.google_calendar_synced_calendars (user_id);
