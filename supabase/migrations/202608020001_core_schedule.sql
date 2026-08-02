create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'Asia/Seoul',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_calendars (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  purpose text not null,
  color_token text,
  is_visible boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_calendars_name_check check (char_length(name) between 1 and 50),
  constraint user_calendars_purpose_check check (purpose in ('personal', 'work', 'custom')),
  constraint user_calendars_sort_order_check check (sort_order >= 0),
  constraint user_calendars_id_user_id_key unique (id, user_id)
);

create unique index user_calendars_user_purpose_default_uidx
on public.user_calendars (user_id, purpose)
where purpose in ('personal', 'work');

create index user_calendars_user_sort_idx
on public.user_calendars (user_id, sort_order, id);

create table public.todos (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  calendar_id uuid not null,
  scheduled_date date not null,
  title text not null,
  entry_kind text not null,
  is_all_day boolean not null default false,
  note text,
  emoji text,
  color text,
  start_at timestamptz,
  end_at timestamptz,
  due_at timestamptz,
  location_name text,
  location_address text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  location_provider text,
  location_provider_id text,
  time_bucket text not null,
  estimated_minutes integer,
  reminder_offset_minutes integer,
  sort_order integer not null default 0,
  status text not null default 'planned',
  progress integer not null default 0,
  source text not null default 'manual',
  is_recurrence_exception boolean not null default false,
  rescheduled_from_id uuid references public.todos(id) on delete set null,
  version integer not null default 1,
  completed_at timestamptz,
  deleted_at timestamptz,
  creation_request_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint todos_calendar_user_fkey
    foreign key (calendar_id, user_id)
    references public.user_calendars(id, user_id)
    on delete restrict,
  constraint todos_title_check check (char_length(title) between 1 and 120),
  constraint todos_note_check check (note is null or char_length(note) <= 2000),
  constraint todos_entry_kind_check check (entry_kind in ('event', 'task')),
  constraint todos_event_time_check check (
    entry_kind <> 'event' or (start_at is not null and end_at is not null)
  ),
  constraint todos_due_kind_check check (entry_kind = 'task' or due_at is null),
  constraint todos_time_order_check check (end_at is null or start_at is null or end_at > start_at),
  constraint todos_time_bucket_check check (time_bucket in ('morning', 'afternoon', 'evening', 'anytime')),
  constraint todos_estimated_minutes_check check (
    estimated_minutes is null or estimated_minutes between 1 and 1440
  ),
  constraint todos_reminder_offset_check check (
    reminder_offset_minutes is null or reminder_offset_minutes between 0 and 10080
  ),
  constraint todos_status_check check (
    status in ('planned', 'in_progress', 'partial', 'completed', 'skipped', 'rescheduled', 'cancelled')
  ),
  constraint todos_progress_check check (progress between 0 and 100),
  constraint todos_source_check check (source in ('manual', 'ai', 'recurring', 'imported')),
  constraint todos_color_check check (
    color is null or color in ('coral', 'amber', 'sage', 'sky', 'indigo', 'violet')
  ),
  constraint todos_location_provider_check check (
    location_provider is null or location_provider in ('apple_maps', 'google_places', 'manual')
  ),
  constraint todos_version_check check (version >= 1),
  constraint todos_completion_check check (
    (status = 'completed' and completed_at is not null and progress = 100)
    or (status <> 'completed' and completed_at is null)
  )
);

create index todos_user_scheduled_active_idx
on public.todos (user_id, scheduled_date, sort_order, id)
where deleted_at is null;

create index todos_user_updated_cursor_idx
on public.todos (user_id, updated_at, id);

create index todos_calendar_id_idx on public.todos (calendar_id);
create index todos_rescheduled_from_id_idx
on public.todos (rescheduled_from_id)
where rescheduled_from_id is not null;

create trigger users_set_updated_at
before update on public.users
for each row execute function public.set_updated_at();

create trigger user_calendars_set_updated_at
before update on public.user_calendars
for each row execute function public.set_updated_at();

create trigger todos_set_updated_at
before update on public.todos
for each row execute function public.set_updated_at();

create or replace function public.initialize_memdo_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id) values (new.id)
  on conflict (id) do nothing;

  insert into public.user_calendars (user_id, name, purpose, sort_order)
  values
    (new.id, '개인', 'personal', 0),
    (new.id, '업무', 'work', 1)
  on conflict do nothing;

  return new;
end;
$$;

create trigger auth_user_created_initialize_memdo
after insert on auth.users
for each row execute function public.initialize_memdo_user();

insert into public.users (id)
select id from auth.users
on conflict (id) do nothing;

insert into public.user_calendars (user_id, name, purpose, sort_order)
select id, '개인', 'personal', 0 from auth.users
on conflict do nothing;

insert into public.user_calendars (user_id, name, purpose, sort_order)
select id, '업무', 'work', 1 from auth.users
on conflict do nothing;

alter table public.users enable row level security;
alter table public.user_calendars enable row level security;
alter table public.todos enable row level security;
alter table public.users force row level security;
alter table public.user_calendars force row level security;
alter table public.todos force row level security;

create policy users_owner_policy on public.users
for all to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy user_calendars_owner_policy on public.user_calendars
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy todos_owner_policy on public.todos
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.users to authenticated;
grant select, insert, update, delete on public.user_calendars to authenticated;
grant select, insert, update, delete on public.todos to authenticated;
