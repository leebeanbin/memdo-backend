create or replace function public.reschedule_todo(
  p_original_id uuid,
  p_replacement_id uuid,
  p_base_version integer,
  p_request_hash text,
  p_entry_kind text,
  p_scheduled_date date,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_due_at timestamptz
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
    and user_id = (select auth.uid());

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
    is_recurrence_exception, rescheduled_from_id, version, creation_request_hash
  ) values (
    p_replacement_id, original.user_id, original.calendar_id, p_scheduled_date,
    original.title, original.entry_kind, original.is_all_day, original.note,
    original.emoji, original.color, p_start_at, p_end_at, p_due_at,
    original.location_name, original.location_address, original.latitude,
    original.longitude, original.location_provider, original.location_provider_id,
    original.time_bucket, original.estimated_minutes,
    original.reminder_offset_minutes, original.sort_order, 'planned', 0,
    original.source, original.is_recurrence_exception, original.id, 1,
    p_request_hash
  )
  returning * into existing;

  return next existing;
end;
$$;

grant execute on function public.reschedule_todo(
  uuid, uuid, integer, text, text, date, timestamptz, timestamptz, timestamptz
) to authenticated;
