-- User-defined schedule categories. Previously device-local only
-- (UserDefaults on iOS) -- didn't survive reinstall or appear on a second
-- device, unlike everything else in the app.
create table public.user_categories (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  emoji text not null,
  color text not null,
  is_task_kind boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_categories_name_check check (char_length(name) between 1 and 30),
  constraint user_categories_emoji_check check (char_length(emoji) between 1 and 8),
  constraint user_categories_color_check check (
    color in ('coral', 'amber', 'sage', 'sky', 'indigo', 'violet')
  ),
  constraint user_categories_sort_order_check check (sort_order >= 0)
);

create index user_categories_user_sort_idx
on public.user_categories (user_id, sort_order, id);

create trigger user_categories_set_updated_at
before update on public.user_categories
for each row execute function public.set_updated_at();

alter table public.user_categories enable row level security;
alter table public.user_categories force row level security;

create policy user_categories_owner_policy on public.user_categories
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.user_categories to authenticated;
