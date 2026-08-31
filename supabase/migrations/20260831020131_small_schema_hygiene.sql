-- bd17: users.timezone is dead -- confirmed via grep across every
-- function, nothing reads or writes it. user_preferences.timezone is the
-- actual single source of truth (resolveUserTimezoneOffsetMinutes, bd5,
-- already merged, reads from there). Drop it so a future reader doesn't
-- have to re-derive that this column is unused, or worse, start reading
-- the wrong one again.
alter table public.users drop column if exists timezone;

-- bd26 (safe slice): schedule_rules has a composite FK-covering index on
-- (calendar_id, user_id) via its own unique/PK-adjacent constraints, but
-- no index on calendar_id alone -- unlike todos, which has
-- todos_calendar_id_idx. Without it, deleting a calendar forces a full
-- table scan of schedule_rules to check/cascade the FK.
create index if not exists schedule_rules_calendar_id_idx
on public.schedule_rules (calendar_id);

-- bd26 (safe slice): user_preferences.calendar_filter is a plain text[]
-- with no FK, so a deleted calendar's id lingers in every user's filter
-- list forever. Strips a deleted calendar's id out of calendar_filter for
-- every user that has it, at the moment the calendar itself is deleted --
-- additive cleanup only, no application code needs to change to benefit
-- from this.
create or replace function public.strip_deleted_calendar_from_filters()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.user_preferences
  set calendar_filter = array_remove(calendar_filter, old.id::text)
  where old.id::text = any(calendar_filter);
  return old;
end;
$$;

drop trigger if exists user_calendars_strip_from_filters on public.user_calendars;
create trigger user_calendars_strip_from_filters
after delete on public.user_calendars
for each row
execute function public.strip_deleted_calendar_from_filters();

-- bd26 (safe slice): workout_logs is the only table in this schema that
-- (a) references auth.users(id) directly instead of public.users(id) like
-- every other table, and (b) has RLS policies using bare auth.uid() instead
-- of the (select auth.uid()) form used elsewhere for query-plan caching.
-- Also adds updated_at (purely additive, same set_updated_at() trigger
-- pattern every other table already uses) -- NOT a version/optimistic-
-- concurrency column, which would need real API + client wiring to
-- actually enforce (a feature addition, deferred, not schema hygiene).
alter table public.workout_logs
  drop constraint if exists workout_logs_user_id_fkey,
  add constraint workout_logs_user_id_fkey
    foreign key (user_id) references public.users(id) on delete cascade;

alter table public.workout_logs
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists workout_logs_set_updated_at on public.workout_logs;
create trigger workout_logs_set_updated_at
before update on public.workout_logs
for each row
execute function public.set_updated_at();

drop policy if exists users_own_workouts on public.workout_logs;
create policy users_own_workouts on public.workout_logs
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists users_own_details on public.workout_log_details;
create policy users_own_details on public.workout_log_details
for all to authenticated
using (
  exists (
    select 1 from public.workout_logs
    where workout_logs.id = workout_log_details.workout_log_id
      and workout_logs.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.workout_logs
    where workout_logs.id = workout_log_details.workout_log_id
      and workout_logs.user_id = (select auth.uid())
  )
);
