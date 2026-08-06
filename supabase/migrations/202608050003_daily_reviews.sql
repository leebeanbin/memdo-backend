-- B6 리뷰: 하루 회고 응답을 계정에 저장한다. (user_id, review_date) PK로 중복 응답을 막고,
-- 재요청은 full-replacement upsert로 처리한다. 기간 요약은 todos 집계로 계산하므로 별도 테이블이 없다.
create table public.daily_reviews (
  user_id uuid not null references public.users(id) on delete cascade,
  review_date date not null,
  reflection text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, review_date),
  constraint daily_reviews_reflection_check check (reflection is null or char_length(reflection) <= 2000)
);

create trigger daily_reviews_set_updated_at
before update on public.daily_reviews
for each row execute function public.set_updated_at();

alter table public.daily_reviews enable row level security;
alter table public.daily_reviews force row level security;

create policy daily_reviews_owner_policy on public.daily_reviews
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

grant select, insert, update on public.daily_reviews to authenticated;
