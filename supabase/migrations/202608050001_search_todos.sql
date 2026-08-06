-- B7 검색: 제목·메모·장소 부분 일치 검색.
-- pg_trgm GIN 인덱스로 ILIKE '%term%'를 인덱스 스캔으로 처리한다.
create extension if not exists pg_trgm with schema extensions;

create index todos_title_trgm_idx
on public.todos using gin (title extensions.gin_trgm_ops)
where deleted_at is null;

create index todos_note_trgm_idx
on public.todos using gin (note extensions.gin_trgm_ops)
where deleted_at is null and note is not null;

create index todos_location_name_trgm_idx
on public.todos using gin (location_name extensions.gin_trgm_ops)
where deleted_at is null and location_name is not null;

-- 파라미터 바인딩으로 안전하게 검색한다(SQL injection 방지). SECURITY DEFINER가
-- 아니므로 호출자 권한으로 실행되어 RLS가 그대로 적용되며, user_id 조건은 이중 방어다.
create or replace function public.search_todos(p_query text, p_limit integer)
returns setof public.todos
language sql
stable
set search_path = ''
as $$
  select *
  from public.todos
  where user_id = (select auth.uid())
    and deleted_at is null
    and status not in ('cancelled', 'skipped', 'rescheduled')
    and (
      title ilike '%' || p_query || '%'
      or note ilike '%' || p_query || '%'
      or location_name ilike '%' || p_query || '%'
    )
  order by scheduled_date desc, id
  limit greatest(p_limit, 0)
$$;

grant execute on function public.search_todos(text, integer) to authenticated;
