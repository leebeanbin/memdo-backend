-- workout_log_full (202608160003_workout_logs.sql) was created without
-- security_invoker and without an explicit revoke, unlike every other
-- table-owning migration in this repo -- it runs as the view owner
-- (postgres, which bypasses RLS), and this project's default privileges
-- grant select broadly to anon/authenticated (see
-- 202608080002_revert_grant_regressions.sql for evidence those defaults are
-- real here). Net effect: any authenticated -- possibly anonymous, see
-- config.toml's enable_anonymous_sign_ins -- caller could very likely read
-- every user's workout history directly via PostgREST, bypassing the
-- workout-logs edge function (and its own manual .eq('user_id', ...)
-- filtering) entirely. Found via founder-dogfooding code review, confirmed
-- by direct read of this migration and of workout-logs/index.ts's own
-- comment admitting "this table's RLS posture was never verified."
--
-- security_invoker makes the view run as the querying role, so the RLS
-- policies already enforced on workout_logs/workout_log_details (same
-- migration, force row level security) apply to it too -- revoking the
-- inherited default grants closes the gap completely regardless.
alter view public.workout_log_full set (security_invoker = true);
revoke all on public.workout_log_full from anon, authenticated;
