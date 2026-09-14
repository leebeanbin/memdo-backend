-- sync_seq (20260829083831_todos_sync_seq.sql, generalized to a shared
-- sequence in 20260831070000) is deliberately ONE monotonic sequence
-- shared across every user and every synced entity type -- but /sync's
-- actual query per entity is `WHERE user_id = X [AND sync_seq > cursor]
-- ORDER BY sync_seq LIMIT n` (sync/index.ts), and each existing sync_seq
-- index (todos_sync_seq_idx, workout_logs_sync_seq_idx,
-- user_categories_sync_seq_idx) covers sync_seq alone, with no user_id
-- column. On a cold/first sync (new device, reinstall, no cursor yet)
-- Postgres can't seek directly to just this user's rows in sync_seq order
-- -- it has to walk the *global* index across every user's rows to
-- accumulate this one user's earliest limit+1 rows. Cost scales with the
-- whole app's row count, not this user's own, on one of the most
-- frequently-called endpoints (called on essentially every app
-- open/reconnect). Composite (user_id, sync_seq) lets Postgres seek
-- straight to this user's slice and walk it in sync_seq order from there.
--
-- workout_log_full's exposed sync_seq is actually
-- greatest(wl.sync_seq, coalesce(wd.sync_seq, 0)) (a computed expression
-- over a join, 20260831070000) -- no index can make that column's ORDER BY
-- itself index-only, but narrowing workout_logs to this user's rows before
-- that join+sort still turns "scan every user's workout_logs" into "scan
-- this user's own," which is the actual problem being fixed here.
drop index if exists public.todos_sync_seq_idx;
create index if not exists todos_user_sync_seq_idx
  on public.todos (user_id, sync_seq);

drop index if exists public.workout_logs_sync_seq_idx;
create index if not exists workout_logs_user_sync_seq_idx
  on public.workout_logs (user_id, sync_seq);

drop index if exists public.user_categories_sync_seq_idx;
create index if not exists user_categories_user_sync_seq_idx
  on public.user_categories (user_id, sync_seq);

-- todos_user_updated_cursor_idx (202608020001_core_schedule.sql) was the
-- old pre-sync_seq cursor index for /sync's original (updated_at, id)
-- ordering -- confirmed (grep across supabase/functions/) nothing orders
-- by updated_at anymore since the sync_seq migration replaced it. Dead
-- weight maintained on every todos insert/update for zero query benefit.
drop index if exists public.todos_user_updated_cursor_idx;
