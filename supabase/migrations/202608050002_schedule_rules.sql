-- B5 반복 일정: 반복 규칙(schedule_rules)과 그로부터 생성된 occurrence(todos) 연결.
create table public.schedule_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  calendar_id uuid not null,
  title text not null,
  entry_kind text not null,
  is_all_day boolean not null default false,
  note text,
  start_time time,
  end_time time,
  time_bucket text not null,
  reminder_offset_minutes integer,
  frequency text not null,
  step_interval integer not null default 1,
  anchor_date date not null,
  until_date date,
  occurrence_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_rules_calendar_user_fkey
    foreign key (calendar_id, user_id)
    references public.user_calendars(id, user_id)
    on delete restrict,
  constraint schedule_rules_title_check check (char_length(title) between 1 and 120),
  constraint schedule_rules_entry_kind_check check (entry_kind in ('event', 'task')),
  constraint schedule_rules_frequency_check check (
    frequency in ('daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly')
  ),
  constraint schedule_rules_interval_check check (step_interval between 1 and 52),
  constraint schedule_rules_time_bucket_check check (
    time_bucket in ('morning', 'afternoon', 'evening', 'anytime')
  ),
  constraint schedule_rules_reminder_check check (
    reminder_offset_minutes is null or reminder_offset_minutes between 0 and 10080
  ),
  constraint schedule_rules_event_time_check check (
    entry_kind <> 'event' or (start_time is not null and end_time is not null)
  ),
  constraint schedule_rules_time_order_check check (
    end_time is null or start_time is null or end_time > start_time
  ),
  constraint schedule_rules_until_check check (until_date is null or until_date >= anchor_date),
  constraint schedule_rules_count_check check (
    occurrence_count is null or occurrence_count between 1 and 730
  )
);

create index schedule_rules_user_idx on public.schedule_rules (user_id, id);

create trigger schedule_rules_set_updated_at
before update on public.schedule_rules
for each row execute function public.set_updated_at();

alter table public.todos
  add column schedule_rule_id uuid references public.schedule_rules(id) on delete set null;

create index todos_schedule_rule_idx
on public.todos (schedule_rule_id)
where schedule_rule_id is not null;

-- One live occurrence per (rule, day) so re-materialising a rule is idempotent.
create unique index todos_rule_occurrence_uidx
on public.todos (schedule_rule_id, scheduled_date)
where schedule_rule_id is not null and deleted_at is null;

alter table public.schedule_rules enable row level security;
alter table public.schedule_rules force row level security;

create policy schedule_rules_owner_policy on public.schedule_rules
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.schedule_rules to authenticated;
