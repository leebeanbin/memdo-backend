-- search_todos previously passed p_query into ilike '%' || p_query || '%' unescaped, so a
-- literal '%' or '_' in the query acted as a wildcard (e.g. q='%' matched every todo) and
-- also defeated the pg_trgm indexes created above. Escape ILIKE metacharacters; '\' is the
-- default ILIKE escape character so no ESCAPE clause is needed.
create or replace function public.search_todos(p_query text, p_limit integer)
returns setof public.todos
language sql
stable
set search_path = ''
as $$
  with escaped as (
    select replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') as term
  )
  select todos.*
  from public.todos, escaped
  where todos.user_id = (select auth.uid())
    and todos.deleted_at is null
    and todos.status not in ('cancelled', 'skipped', 'rescheduled')
    and (
      todos.title ilike '%' || escaped.term || '%'
      or todos.note ilike '%' || escaped.term || '%'
      or todos.location_name ilike '%' || escaped.term || '%'
    )
  order by todos.scheduled_date desc, todos.id
  limit greatest(p_limit, 0)
$$;
