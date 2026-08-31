-- bd22: agent_chat_requests stays separate (atomic rate-limit RPC + 1-day
-- retention -- structurally incompatible with the other two). But
-- agent_usage_log and agent_audit_log are both written at the same point
-- in agent-cloud-chat/index.ts's close() (not a start/end two-phase write),
-- differing only in that agent_usage_log's insert is conditional on
-- completedCalls > 0 while agent_audit_log's is unconditional. That's a
-- single conditional-field row, not two tables. Extend agent_audit_log
-- with the usage fields (nullable -- null means "no completed provider
-- call for this turn," matching exactly agent_usage_log's own existing
-- write condition) and drop agent_usage_log. No backfill: there is no
-- reliable join key between the two tables to reconstruct which
-- agent_usage_log row corresponds to which agent_audit_log row, and this
-- is founder-dogfooding cost/token history, not user data.
alter table public.agent_audit_log
  add column prompt_tokens integer,
  add column completion_tokens integer,
  add column cost_usd numeric(10, 6),
  add constraint agent_audit_log_prompt_tokens_check
    check (prompt_tokens is null or prompt_tokens >= 0),
  add constraint agent_audit_log_completion_tokens_check
    check (completion_tokens is null or completion_tokens >= 0),
  add constraint agent_audit_log_cost_usd_check
    check (cost_usd is null or cost_usd >= 0);

drop function public.agent_usage_summary(integer);

-- Aggregate in Postgres so the Edge Function does not download up to 30
-- days of rows merely to sum one number -- same shape as the function this
-- replaces, now reading agent_audit_log's merged usage columns instead of
-- the dropped agent_usage_log table. `prompt_tokens is not null` is the
-- "this row actually incurred usage" filter, matching agent_usage_log's
-- old population condition exactly (completedCalls > 0).
create function public.agent_usage_summary(p_days integer default 30)
returns table (
  total_requests bigint,
  total_cost_usd numeric,
  recent jsonb
)
language sql
stable
set search_path = ''
as $$
  with scoped as materialized (
    select model, cost_usd, created_at
    from public.agent_audit_log
    where user_id = (select auth.uid())
      and prompt_tokens is not null
      and created_at >= now() - make_interval(days => greatest(1, least(p_days, 365)))
  )
  select
    count(*)::bigint,
    coalesce(sum(cost_usd), 0),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'model', latest.model,
            'costUsd', latest.cost_usd,
            'createdAt', latest.created_at
          )
          order by latest.created_at desc
        )
        from (
          select model, cost_usd, created_at
          from scoped
          order by created_at desc
          limit 5
        ) as latest
      ),
      '[]'::jsonb
    )
  from scoped;
$$;

revoke all on function public.agent_usage_summary(integer) from public, anon;
grant execute on function public.agent_usage_summary(integer) to authenticated;

drop table public.agent_usage_log;
