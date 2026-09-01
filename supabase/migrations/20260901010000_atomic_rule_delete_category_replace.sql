-- be17: DELETE /rules/{id} and PUT /categories each did two sequential,
-- unguarded Supabase calls with a real inconsistent-state window between
-- them if the process crashed or errored mid-way -- rules DELETE could
-- soft-delete a rule's future todos but leave the rule itself active;
-- categories PUT could commit new/updated categories but never prune the
-- stale ones. Wrapped in a single plpgsql function each, called via
-- .rpc(...), for the same single-transaction atomicity reschedule_todo
-- already relies on (20260830034727_reschedule_todo_replay_lock.sql) --
-- neither function declares security definer/invoker (defaults to
-- invoker, RLS applies), and both repeat `user_id = (select auth.uid())`
-- explicitly on every statement as defense-in-depth on top of RLS, not
-- reliance on RLS alone -- the same belt-and-suspenders pattern
-- reschedule_todo's own locking select already uses.

-- Ordering matters here, not just wrapping the two statements: existence,
-- ownership, and not-already-deleted are confirmed and the row locked
-- BEFORE any child todo is touched. A second update matching zero rows is
-- not a SQL error, so it would NOT roll back an earlier todos update inside
-- the same function body -- an ordering that mutated todos first would let
-- a request against someone else's rule, or an already-deleted rule, still
-- silently soft-delete that rule's future todos as an undetected side
-- effect of a call that appears, from the outside, to have done nothing
-- (still returns the existing 404).
create or replace function public.delete_schedule_rule_atomic(
  p_rule_id uuid,
  p_today date
)
returns table(id uuid)
language plpgsql
set search_path = ''
as $$
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
$$;

-- No p_user_id parameter -- every row this writes uses (select auth.uid())
-- directly (the upsert's user_id column value and the prune's user_id
-- filter), so there is no client-suppliable user_id value to spoof in the
-- first place, not just a check to remember.
--
-- HTTP-semantics: PUT /categories always returns 200 on success today, with
-- no existing not-found/partial-success branch to preserve -- an empty
-- categories:[] array already succeeds, pruning everything. This function
-- preserves exactly that: it either applies both halves atomically or
-- raises (caught by the caller's existing try/catch -> 500), never a
-- partial state.
create or replace function public.replace_user_categories_atomic(
  p_rows jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
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
$$;
