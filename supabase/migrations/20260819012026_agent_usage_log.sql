-- Durable per-request Agent usage. The existing agent_chat_requests table
-- remains a short-lived rate-limit ledger; this table is user-visible usage
-- history and intentionally has no retention job yet.
create table public.agent_usage_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now(),
  constraint agent_usage_log_prompt_tokens_check check (prompt_tokens >= 0),
  constraint agent_usage_log_completion_tokens_check check (completion_tokens >= 0),
  constraint agent_usage_log_cost_usd_check check (cost_usd >= 0)
);

create index agent_usage_log_user_created_idx
on public.agent_usage_log (user_id, created_at desc);

alter table public.agent_usage_log enable row level security;
alter table public.agent_usage_log force row level security;

create policy agent_usage_log_select_own
on public.agent_usage_log
for select
to authenticated
using ((select auth.uid()) = user_id);

grant select on public.agent_usage_log to authenticated;
revoke insert, update, delete on public.agent_usage_log from authenticated;
revoke all on public.agent_usage_log from anon;

-- Aggregate in Postgres so the Edge Function does not download up to 30 days
-- of rows merely to sum one number. This is SECURITY INVOKER and repeats the
-- owner predicate, so the table RLS remains the enforcement boundary.
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
    from public.agent_usage_log
    where user_id = (select auth.uid())
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
