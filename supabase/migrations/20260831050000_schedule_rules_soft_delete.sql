-- bd21: DELETE /rules/{id} hard-deleted the schedule_rules row after soft-
-- deleting only its future occurrences, but todos.schedule_rule_id ->
-- schedule_rules(id) is `on delete set null` -- so every PAST occurrence
-- kept for history (deliberately not soft-deleted, same as todos'
-- deleted_at convention) silently lost its schedule_rule_id and, with it,
-- any record of which recurring series it came from. Unify with todos'
-- existing soft-delete + revoked-DELETE convention (202608030001).
alter table public.schedule_rules add column deleted_at timestamptz;

revoke delete on table public.schedule_rules from authenticated;
