-- Two-way Google Calendar sync: schema for Memdo -> Google push-back and
-- materialize-on-edit of a previously read-only mirrored event.
--
-- google_event_id / google_synced_at let a todos row point at the Google
-- event it's linked to (either because it was pushed there, or because it
-- was materialized from a google_calendar_mirror_events row on first edit).
alter table public.todos
  add column google_event_id text,
  add column google_synced_at timestamptz;

-- A materialized Google-mirrored item is inserted with source =
-- 'google_calendar', a new value this check constraint didn't allow before
-- (it only ever needed to describe rows Memdo itself originated).
alter table public.todos drop constraint todos_source_check;
alter table public.todos
  add constraint todos_source_check
  check (source in ('manual', 'ai', 'recurring', 'imported', 'google_calendar'));

-- A Google event is linked from at most one todos row at a time.
create unique index todos_google_event_id_uidx
  on public.todos (google_event_id)
  where google_event_id is not null;

-- One row per todo needing a push to Google, collapsed via
-- enqueue_google_push() below using the same semantics as the iOS client's
-- own OutboxQueue (OutboxQueue.swift): a pending 'create' poisons the slot
-- (later ops just stay 'create'; a later 'delete' cancels the row outright,
-- since nothing was ever pushed to Google yet); otherwise last-write-wins.
create table public.google_calendar_push_queue (
  id uuid primary key default gen_random_uuid(),
  todo_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  connection_id uuid not null references public.google_calendar_connections(id) on delete cascade,
  operation text not null check (operation in ('create', 'update', 'delete')),
  -- required for update/delete; null for create until Google assigns one
  google_event_id text,
  attempts int not null default 0,
  last_error text,
  enqueued_at timestamptz not null default now(),
  unique (todo_id)
);

alter table public.google_calendar_push_queue enable row level security;
-- Same convention as google_calendar_mirror_events: no client-facing RLS
-- policies -- only the service-role-authenticated push cron/edge function
-- touches this table directly.
grant select, insert, update, delete on public.google_calendar_push_queue to service_role;

-- security definer (owned by postgres) so it doesn't need service_role to
-- separately hold table grants -- matches this migration's own table grants
-- above being service_role-only.
create or replace function public.enqueue_google_push(
  p_todo_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_operation text,
  p_google_event_id text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_op text;
begin
  select operation into v_existing_op
  from google_calendar_push_queue
  where todo_id = p_todo_id
  for update;

  if v_existing_op = 'create' and p_operation = 'delete' then
    -- Nothing was ever pushed to Google -- cancel the pending create
    -- rather than queuing a delete for an event that doesn't exist there.
    delete from google_calendar_push_queue where todo_id = p_todo_id;
    return;
  end if;

  insert into google_calendar_push_queue (todo_id, user_id, connection_id, operation, google_event_id)
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

grant execute on function public.enqueue_google_push(uuid, uuid, uuid, text, text) to service_role;

-- Reuse the same 1-minute-tick internal-auth secret as the existing pull
-- cron (google-calendar-sync) -- deliberately not a new, similarly-named
-- secret. See docs/work-log.md / this migration's PR for the incident this
-- is directly informed by: GOOGLE_CALENDAR_SYNC_SECRET was once set to the
-- same value as GOOGLE_CALENDAR_CLIENT_SECRET by mistake, silently breaking
-- the pull cron for hours because the two are unrelated secrets that only
-- happen to share a similar name.
select cron.schedule(
  'google-calendar-push',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://snfvykovzybfpwomnxhj.supabase.co/functions/v1/google-calendar-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'google_calendar_sync_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
