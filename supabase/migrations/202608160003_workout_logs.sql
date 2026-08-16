-- workout_logs/workout_log_details/workout_log_full and the workout-logs
-- edge function were deployed directly against production (one-off local
-- `supabase functions deploy`, no import_map, no migration) and never
-- existed in this repo at all -- a fresh environment or DR restore from
-- migrations would silently lose workout tracking entirely. This records
-- the live schema exactly as found so history catches up with reality.
create table if not exists public.workout_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  hk_uuid text,
  source text not null default 'manual',
  activity_type text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_sec integer not null,
  distance_m double precision,
  calories double precision,
  avg_heart_rate double precision,
  route_image_url text,
  photo_url text,
  scheduled_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workout_log_details (
  workout_log_id uuid primary key references public.workout_logs(id) on delete cascade,
  location_name text,
  notes text not null default '',
  exercises jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_wl_user_date on public.workout_logs (user_id, scheduled_date desc);
create index if not exists idx_wl_user_started on public.workout_logs (user_id, started_at desc);
create unique index if not exists idx_wl_hk_uuid on public.workout_logs (hk_uuid) where hk_uuid is not null;
create index if not exists idx_wl_hk_source on public.workout_logs (user_id, hk_uuid)
  where source = 'healthkit' and hk_uuid is not null;

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
  wd.updated_at as detail_updated_at
from public.workout_logs wl
left join public.workout_log_details wd on wl.id = wd.workout_log_id;

alter table public.workout_logs enable row level security;
alter table public.workout_logs force row level security;
alter table public.workout_log_details enable row level security;
alter table public.workout_log_details force row level security;

drop policy if exists users_own_workouts on public.workout_logs;
create policy users_own_workouts on public.workout_logs
for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists users_own_details on public.workout_log_details;
create policy users_own_details on public.workout_log_details
for all to authenticated
using (
  exists (
    select 1 from public.workout_logs
    where workout_logs.id = workout_log_details.workout_log_id
      and workout_logs.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workout_logs
    where workout_logs.id = workout_log_details.workout_log_id
      and workout_logs.user_id = auth.uid()
  )
);
