-- Same shape as google_calendar_mirror_events/google_calendar_connections'
-- own RLS (202608090004_google_calendar_mirror.sql): readable by its owner
-- (GET /calendars lists it, todo-list-contract.ts embeds its color_token),
-- everything else about it is service-role only by omission -- the
-- google-calendar-synced-calendars function does every write with
-- serviceClient(), never context.supabase.
alter table public.google_calendar_synced_calendars enable row level security;
alter table public.google_calendar_synced_calendars force row level security;

create policy google_calendar_synced_calendars_owner_select_policy
on public.google_calendar_synced_calendars
for select to authenticated
using (user_id = (select auth.uid()));

grant select on public.google_calendar_synced_calendars to authenticated;
