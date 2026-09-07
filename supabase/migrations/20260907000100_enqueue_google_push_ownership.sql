-- Security fix: enqueue_google_push() was SECURITY DEFINER with EXECUTE
-- granted to `service_role` only in its own migration -- but Postgres
-- grants EXECUTE to PUBLIC by default on CREATE FUNCTION, and that grant
-- was never explicitly revoked here (unlike the vault_* functions in the
-- same earlier migration, which do `revoke execute ... from public,
-- authenticated, anon` right after creation). Confirmed live via
-- has_function_privilege: both `anon` and `authenticated` held EXECUTE,
-- and the function body did zero ownership validation on
-- p_todo_id/p_user_id/p_connection_id -- any authenticated caller (or
-- anon, holding only the app's public anon key) could enqueue a push
-- referencing an arbitrary todo/connection belonging to a different user,
-- and the push cron (google-calendar-push) would push that victim's data
-- into the caller's own Google Calendar using the caller's own token.
--
-- `authenticated` genuinely needs EXECUTE: queueAndPushGoogleSync calls
-- this RPC via context.supabase (the JWT-bound client), from all three
-- todos/index.ts write paths. `service_role` never actually calls this RPC
-- (grep confirms queueAndPushGoogleSync is the only caller, always via
-- context.supabase) -- dropping that unused grant too, not just leaving it
-- as harmless dead permission.
create or replace function public.enqueue_google_push(
  p_todo_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_operation text,
  p_google_event_id text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_existing_op text;
begin
  -- SECURITY DEFINER bypasses RLS entirely -- every ownership check RLS
  -- would normally provide has to be explicit here instead.
  if v_caller is null or v_caller <> p_user_id then
    raise exception 'enqueue_google_push: p_user_id does not match the calling user';
  end if;

  if not exists (
    select 1 from public.todos
    where id = p_todo_id and user_id = v_caller and deleted_at is null
  ) then
    raise exception 'enqueue_google_push: todo not found for this user';
  end if;

  if not exists (
    select 1 from public.google_calendar_connections
    where id = p_connection_id and user_id = v_caller and status = 'active'
  ) then
    raise exception 'enqueue_google_push: connection not found or inactive for this user';
  end if;

  -- Shape validation, matching what every legitimate caller already sends
  -- (queueAndPushGoogleSync): update/delete need a real target event id;
  -- create must not claim one (nothing exists on Google yet to reference).
  if p_operation not in ('create', 'update', 'delete') then
    raise exception 'enqueue_google_push: invalid operation %', p_operation;
  end if;
  if p_operation in ('update', 'delete') and p_google_event_id is null then
    raise exception 'enqueue_google_push: % requires p_google_event_id', p_operation;
  end if;
  if p_operation = 'create' and p_google_event_id is not null then
    raise exception 'enqueue_google_push: create must not carry a google_event_id';
  end if;

  select operation into v_existing_op
  from public.google_calendar_push_queue
  where todo_id = p_todo_id
  for update;

  if v_existing_op = 'create' and p_operation = 'delete' then
    -- Nothing was ever pushed to Google -- cancel the pending create
    -- rather than queuing a delete for an event that doesn't exist there.
    delete from public.google_calendar_push_queue where todo_id = p_todo_id;
    return;
  end if;

  insert into public.google_calendar_push_queue
    (todo_id, user_id, connection_id, operation, google_event_id)
  values (p_todo_id, p_user_id, p_connection_id, p_operation, p_google_event_id)
  on conflict (todo_id) do update set
    operation = case
      when google_calendar_push_queue.operation = 'create' then 'create'
      else excluded.operation
    end,
    google_event_id = coalesce(excluded.google_event_id, google_calendar_push_queue.google_event_id),
    attempts = 0,
    last_error = null,
    enqueued_at = now();
end;
$$;

revoke execute on function public.enqueue_google_push(uuid, uuid, uuid, text, text)
  from public, anon, service_role;
grant execute on function public.enqueue_google_push(uuid, uuid, uuid, text, text)
  to authenticated;
