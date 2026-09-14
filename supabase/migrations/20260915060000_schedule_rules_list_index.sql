-- GET /rules (schedule_rules.list) queries
-- `WHERE user_id = X AND deleted_at IS NULL ORDER BY created_at DESC, id`
-- (RLS supplies the user_id predicate), but schedule_rules' existing
-- indexes -- schedule_rules_user_idx (user_id, id) and
-- schedule_rules_calendar_user_idx (calendar_id, user_id) -- cover neither
-- deleted_at nor created_at, so this always sorts in memory rather than
-- using an index for order. A user's rule count stays naturally small
-- (distinct recurring patterns, not per-day history), so this is a minor
-- fix, not the load-bearing one -- added alongside rules/index.ts's new
-- .limit(200) safety cap.
create index if not exists schedule_rules_user_active_created_idx
  on public.schedule_rules (user_id, created_at desc, id)
  where deleted_at is null;
