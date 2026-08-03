create table public.user_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  timezone text not null default 'Asia/Seoul',
  widget_style text not null default 'next_todo',
  default_mood text,
  hide_widget_content boolean not null default false,
  notifications_enabled boolean not null default true,
  planning_prompt_time time,
  quiet_hours_start time,
  quiet_hours_end time,
  calendar_filter text[] not null default '{}',
  daily_review_enabled boolean not null default false,
  daily_review_time time,
  daily_review_days text[] not null default '{MO,TU,WE,TH,FR,SA,SU}',
  daily_review_include_reflection boolean not null default true,
  news_briefing_enabled boolean not null default false,
  news_briefing_time time,
  news_briefing_days text[] not null default '{MO,TU,WE,TH,FR,SA,SU}',
  news_briefing_last_generated_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_preferences_timezone_check check (char_length(timezone) between 1 and 100),
  constraint user_preferences_widget_style_check check (widget_style in ('next_todo', 'daily_intention')),
  constraint user_preferences_default_mood_check check (
    default_mood is null or default_mood in ('focus', 'relaxed', 'active', 'recovery', 'excited')
  ),
  constraint user_preferences_quiet_hours_check check (
    (quiet_hours_start is null) = (quiet_hours_end is null)
  ),
  constraint user_preferences_daily_review_days_check check (
    daily_review_days <@ array['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']::text[]
    and (not daily_review_enabled or (daily_review_time is not null and cardinality(daily_review_days) > 0))
  ),
  constraint user_preferences_news_briefing_days_check check (
    news_briefing_days <@ array['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']::text[]
    and (not news_briefing_enabled or (news_briefing_time is not null and cardinality(news_briefing_days) > 0))
  )
);

create trigger user_preferences_set_updated_at
before update on public.user_preferences
for each row execute function public.set_updated_at();

insert into public.user_preferences (user_id)
select id from public.users
on conflict (user_id) do nothing;

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

  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

alter table public.user_preferences enable row level security;
alter table public.user_preferences force row level security;

create policy user_preferences_owner_policy on public.user_preferences
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

grant select, insert, update on public.user_preferences to authenticated;
