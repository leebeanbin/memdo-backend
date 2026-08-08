revoke all on function public.initialize_memdo_user() from public;
revoke execute on function public.initialize_memdo_user() from anon, authenticated;

drop index if exists public.todos_calendar_id_idx;

create index if not exists todos_calendar_user_idx
on public.todos (calendar_id, user_id);
