-- PostgreSQL grants EXECUTE to PUBLIC by default on CREATE FUNCTION. Neither function is
-- security definer and both filter on auth.uid() (null for anon) with RLS applying, so this
-- isn't currently exploitable -- but 202608030004 already established this same hardening
-- pattern for initialize_memdo_user, and these two were missed.
revoke all on function public.search_todos(text, integer) from public, anon;

revoke all on function public.reschedule_todo(
  uuid, uuid, integer, text, text, date, timestamptz, timestamptz, timestamptz, text
) from public, anon;

grant execute on function public.search_todos(text, integer) to authenticated;
grant execute on function public.reschedule_todo(
  uuid, uuid, integer, text, text, date, timestamptz, timestamptz, timestamptz, text
) to authenticated;
