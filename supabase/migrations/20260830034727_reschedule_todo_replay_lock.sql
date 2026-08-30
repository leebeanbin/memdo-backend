-- reschedule_todo's replacement-row lookup wasn't `for update`, only the
-- original row's was. A concurrent retry of the same request (network
-- retry with the same Idempotency-Key) could race: the retry's first
-- select (replacement lookup) runs while the first call is still mid-
-- transaction and finds nothing yet (the row isn't inserted until later in
-- that same transaction); the retry then blocks on the *original* row's
-- `for update` lock instead. Once the first call commits, the retry's lock
-- wait resolves with the original already bumped to the next version, so
-- its own validation (`original.version <> p_base_version`) fails and it
-- returns empty -- back in todos/index.ts, that reads as "the replacement
-- id was already used by someone else" (IDEMPOTENCY_CONFLICT, 409), even
-- though it's the exact same request being retried and should have replayed
-- successfully via the function's own existing `if found` branch. Found via
-- founder-dogfooding code review (be9).
--
-- Locking the replacement lookup too makes the retry serialize behind the
-- first call's insert instead of the original row's update -- once it
-- resolves, the replacement row is already there (or the whole transaction
-- rolled back and it genuinely doesn't exist), so the function's own replay
-- check does the right thing either way.
create or replace function public.reschedule_todo(
  p_original_id uuid,
  p_replacement_id uuid,
  p_base_version integer,
  p_request_hash text,
  p_entry_kind text,
  p_scheduled_date date,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_due_at timestamptz,
  p_time_bucket text
)
returns setof public.todos
language plpgsql
set search_path = ''
as $$
declare
  existing public.todos%rowtype;
  original public.todos%rowtype;
begin
  select * into existing
  from public.todos
  where id = p_replacement_id
    and user_id = (select auth.uid())
  for update;

  if found then
    if existing.creation_request_hash = p_request_hash
       and existing.rescheduled_from_id = p_original_id then
      return next existing;
    end if;
    return;
  end if;

  select * into original
  from public.todos
  where id = p_original_id
    and user_id = (select auth.uid())
    and deleted_at is null
  for update;

  if not found
     or original.version <> p_base_version
     or original.entry_kind <> p_entry_kind
     or (original.entry_kind = 'event' and (p_start_at is null or p_end_at is null or p_due_at is not null))
     or ((p_start_at is null) <> (p_end_at is null))
     or (p_start_at is not null and p_end_at <= p_start_at)
     or original.status not in ('planned', 'in_progress', 'partial') then
    return;
  end if;

  update public.todos
  set status = 'rescheduled',
      progress = 0,
      completed_at = null,
      version = version + 1
  where id = original.id;

  insert into public.todos (
    id, user_id, calendar_id, scheduled_date, title, entry_kind, is_all_day,
    note, emoji, color, start_at, end_at, due_at, location_name,
    location_address, latitude, longitude, location_provider,
    location_provider_id, time_bucket, estimated_minutes,
    reminder_offset_minutes, sort_order, status, progress, source,
    is_recurrence_exception, schedule_rule_id, rescheduled_from_id, version,
    creation_request_hash
  ) values (
    p_replacement_id, original.user_id, original.calendar_id, p_scheduled_date,
    original.title, original.entry_kind, original.is_all_day, original.note,
    original.emoji, original.color, p_start_at, p_end_at, p_due_at,
    original.location_name, original.location_address, original.latitude,
    original.longitude, original.location_provider, original.location_provider_id,
    p_time_bucket, original.estimated_minutes,
    original.reminder_offset_minutes, original.sort_order, 'planned', 0,
    original.source, true, original.schedule_rule_id,
    original.id, 1, p_request_hash
  )
  returning * into existing;

  return next existing;
end;
$$;
