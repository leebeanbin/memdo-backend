-- Reconstructed from the live database (2026-09-08): this migration's
-- original file was never committed to this checkout, even though its
-- effect is applied and has been running in production since 2026-09-01.
-- Content below is byte-identical to pg_get_functiondef() against the live
-- functions, so this file only documents history -- it changes nothing
-- that isn't already live.
create or replace function public.delete_schedule_rule_atomic(p_rule_id uuid, p_today date)
returns table(id uuid)
language plpgsql
set search_path to ''
as $function$
declare
  v_rule_id uuid;
begin
  select sr.id into v_rule_id
  from public.schedule_rules sr
  where sr.id = p_rule_id
    and sr.user_id = (select auth.uid())
    and sr.deleted_at is null
  for update;

  -- Not found / wrong owner / already deleted -- perform NO mutations and
  -- return zero rows, mirroring reschedule_todo's own "empty result means
  -- not found" convention so rules/index.ts's existing
  -- .rpc(...).select('id').maybeSingle() -> null -> 404 branch is unchanged.
  if v_rule_id is null then
    return;
  end if;

  -- Mirrors rules/index.ts's existing eligibility filter: drop future,
  -- non-exception occurrences; keep past ones (and edited exceptions) as
  -- history.
  update public.todos
  set deleted_at = now()
  where schedule_rule_id = v_rule_id
    and user_id = (select auth.uid())
    and is_recurrence_exception = false
    and scheduled_date >= p_today
    and deleted_at is null;

  update public.schedule_rules
  set deleted_at = now()
  where schedule_rules.id = v_rule_id
    and user_id = (select auth.uid());

  return query select v_rule_id;
end;
$function$;

create or replace function public.replace_user_categories_atomic(p_rows jsonb)
returns void
language plpgsql
set search_path to ''
as $function$
declare
  v_ids uuid[];
begin
  if jsonb_array_length(p_rows) > 0 then
    insert into public.user_categories (
      id, user_id, name, emoji, color, is_task_kind, sort_order, deleted_at
    )
    select
      (row_value->>'id')::uuid,
      (select auth.uid()),
      row_value->>'name',
      row_value->>'emoji',
      row_value->>'color',
      (row_value->>'isTaskKind')::boolean,
      row_ordinal - 1,
      null
    from jsonb_array_elements(p_rows) with ordinality as t(row_value, row_ordinal)
    -- bd20: onConflict target follows the PK, (id, user_id) -- a
    -- client-generated id colliding with a DIFFERENT user's category can't
    -- conflict, since every inserted row already carries this caller's own
    -- auth.uid().
    on conflict (id, user_id) do update set
      name = excluded.name,
      emoji = excluded.emoji,
      color = excluded.color,
      is_task_kind = excluded.is_task_kind,
      sort_order = excluded.sort_order,
      -- bd26: explicit, not omitted -- revives a previously soft-deleted
      -- category id the caller is re-adding.
      deleted_at = null;
  end if;

  select array_agg((row_value->>'id')::uuid) into v_ids
  from jsonb_array_elements(p_rows) as row_value;

  -- bd26: soft delete, matching todos'/schedule_rules' convention. An empty
  -- p_rows prunes everything for this user -- `id = any('{}')` is always
  -- false, so `not (...)` is always true, with no separate empty-array
  -- branch needed.
  update public.user_categories
  set deleted_at = now()
  where user_id = (select auth.uid())
    and deleted_at is null
    and not (id = any(coalesce(v_ids, array[]::uuid[])));
end;
$function$;
