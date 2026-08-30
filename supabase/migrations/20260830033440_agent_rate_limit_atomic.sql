-- agent-cloud-chat/index.ts used to check-then-insert against
-- agent_chat_requests as two separate statements with a Vault read in
-- between -- N concurrent requests from the same user all read the same
-- count and all pass, trivially exceeding RATE_LIMIT_PER_HOUR. The insert
-- was also fail-open: a failure there was logged and the request continued
-- anyway, so the limit silently stops counting entirely if the insert ever
-- breaks (constraint, connection exhaustion, the hourly cleanup cron
-- holding a lock). Found via founder-dogfooding code review (be4).
--
-- pg_advisory_xact_lock keyed by the user's own id serializes concurrent
-- calls for the *same* user (different users never contend), making the
-- count-then-insert atomic without needing a table-level lock or
-- SERIALIZABLE isolation. security definer so the edge function's
-- service-role caller doesn't need direct table privileges beyond execute.
create or replace function public.agent_rate_limit_check_and_log(
  p_user_id uuid,
  p_window_start timestamptz,
  p_limit integer
)
returns table(allowed boolean, current_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select count(*) into v_count
  from public.agent_chat_requests
  where user_id = p_user_id and created_at >= p_window_start;

  if v_count >= p_limit then
    return query select false, v_count;
    return;
  end if;

  insert into public.agent_chat_requests (user_id) values (p_user_id);
  return query select true, v_count + 1;
end;
$$;

revoke all on function public.agent_rate_limit_check_and_log(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.agent_rate_limit_check_and_log(uuid, timestamptz, integer) to service_role;
