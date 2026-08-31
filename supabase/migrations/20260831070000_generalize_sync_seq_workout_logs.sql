-- bd26: /sync only ever reports entityType:'todo'. workout_logs has no
-- DELETE endpoint (nothing to soft-delete/tombstone), so it only needs
-- create/update sync -- the simpler of the two entities being added this
-- round (user_categories, which does support delete, follows separately
-- with its own soft-delete migration).
--
-- Generalize todos_sync_seq (20260829083831_todos_sync_seq.sql) into one
-- global sequence shared across entity types, so /sync's cursor stays a
-- single opaque monotonic number instead of needing a compound per-entity
-- cursor.
alter sequence public.todos_sync_seq rename to sync_seq;

create or replace function public.set_sync_seq()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.sync_seq = nextval('public.sync_seq');
  return new;
end;
$$;

drop trigger todos_set_sync_seq on public.todos;
create trigger todos_set_sync_seq
before insert or update on public.todos
for each row execute function public.set_sync_seq();

drop function public.set_todo_sync_seq();

-- workout_logs and workout_log_details (PATCH .../details updates the
-- latter independently, sometimes long after the workout was logged) both
-- need their own sync_seq -- workout_log_full (the view the API actually
-- reads) exposes the effective one as greatest(wl.sync_seq,
-- coalesce(wd.sync_seq, 0)), so a details-only edit still bumps the row's
-- position in the sync stream even though workout_logs itself didn't
-- change.
alter table public.workout_logs add column sync_seq bigint;
update public.workout_logs set sync_seq = nextval('public.sync_seq') where sync_seq is null;
alter table public.workout_logs alter column sync_seq set not null;
create index workout_logs_sync_seq_idx on public.workout_logs (sync_seq);
create trigger workout_logs_set_sync_seq
before insert or update on public.workout_logs
for each row execute function public.set_sync_seq();

alter table public.workout_log_details add column sync_seq bigint;
update public.workout_log_details set sync_seq = nextval('public.sync_seq') where sync_seq is null;
alter table public.workout_log_details alter column sync_seq set not null;
create index workout_log_details_sync_seq_idx on public.workout_log_details (sync_seq);
create trigger workout_log_details_set_sync_seq
before insert or update on public.workout_log_details
for each row execute function public.set_sync_seq();

-- security_invoker + the anon/authenticated revoke (20260829080903) are a
-- real security fix from an earlier round -- CREATE OR REPLACE VIEW's
-- interaction with previously-ALTERed reloptions/grants isn't something to
-- assume about, so both are re-asserted explicitly right after the
-- replace rather than trusted to survive it implicitly. New columns are
-- appended at the end, not inserted -- CREATE OR REPLACE VIEW requires
-- every pre-existing column to keep both its name and its position.
create or replace view public.workout_log_full as
select
  wl.id,
  wl.user_id,
  wl.hk_uuid,
  wl.source,
  wl.activity_type,
  wl.started_at,
  wl.ended_at,
  wl.duration_sec,
  wl.distance_m,
  wl.calories,
  wl.avg_heart_rate,
  wl.route_image_url,
  wl.photo_url,
  wl.scheduled_date,
  wl.created_at,
  coalesce(wd.location_name, '') as location_name,
  coalesce(wd.notes, '') as notes,
  wd.exercises,
  wd.updated_at as detail_updated_at,
  wl.updated_at,
  greatest(wl.sync_seq, coalesce(wd.sync_seq, 0)) as sync_seq
from public.workout_logs wl
left join public.workout_log_details wd on wl.id = wd.workout_log_id;

alter view public.workout_log_full set (security_invoker = true);
revoke all on public.workout_log_full from anon, authenticated;
