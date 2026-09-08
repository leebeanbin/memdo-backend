-- Performance pass (get_advisors, performance category): drop a duplicate
-- index maintained on every todos write for no benefit, and add the FK-
-- covering indexes the advisor flagged as missing -- these matter both for
-- direct filtering on the referencing column and for ON DELETE
-- CASCADE/RESTRICT performance (a delete on the referenced row otherwise
-- has to sequentially scan the referencing table).

-- idx_todos_rule and todos_schedule_rule_idx are byte-identical
-- (CREATE INDEX ... ON todos USING btree (schedule_rule_id) WHERE
-- schedule_rule_id IS NOT NULL) -- keep the more descriptively-named one.
drop index if exists public.idx_todos_rule;

create index if not exists google_calendar_oauth_states_user_id_idx
  on public.google_calendar_oauth_states (user_id);

create index if not exists google_calendar_push_queue_connection_id_idx
  on public.google_calendar_push_queue (connection_id);

create index if not exists google_calendar_push_queue_user_id_idx
  on public.google_calendar_push_queue (user_id);

create index if not exists schedule_rules_calendar_user_idx
  on public.schedule_rules (calendar_id, user_id);

create index if not exists todos_category_user_idx
  on public.todos (category_id, user_id);
