create index todos_user_day_active_idx
on public.todos (user_id, scheduled_date, start_at, sort_order, id)
where deleted_at is null;
