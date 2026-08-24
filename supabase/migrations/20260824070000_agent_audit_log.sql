-- Per-request traceability for accepted agent executions (Epic H). Distinct
-- from agent_usage_log: that table only ever holds rows for calls that
-- actually incurred cost (completedCalls > 0), and F-2's eval:compare
-- depends on a strict requestCount === completedCount invariant against it.
-- This table needs a row for every accepted agent execution, including ones
-- that fail before any OpenRouter call completes -- different population
-- semantics for the same underlying event, kept fully separate so F-2's
-- invariant is untouched.
create table public.agent_audit_log (
  id bigint generated always as identity primary key,
  -- Server-generated only (never the client-controllable X-Request-ID) --
  -- unique is a DB-enforced contract, not just an application convention.
  agent_run_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  -- Single value today (agent-cloud-chat's tool loop is the only agent
  -- workflow) -- kept as a real column, not inlined, so a future distinct
  -- workflow (e.g. a routine/review agent path) doesn't need a migration to
  -- become distinguishable. Same reasoning as ModelProfile.supportsTools in
  -- Epic G: always one value today, but documents a real future axis.
  workflow_name text not null,
  model text not null,
  tool_names text[] not null default '{}',
  tool_call_count integer not null default 0,
  latency_ms integer not null,
  -- Exactly the 3 exit paths in agent-cloud-chat/index.ts's stream handler:
  -- the tool loop ended with a final text turn ('answered'), ran out of
  -- MAX_TOOL_ITERATIONS without one ('exhausted_iterations'), or the
  -- handler threw ('error'). Derived directly from control flow, not a
  -- separate semantic classification layered on top.
  result_kind text not null
    check (result_kind in ('answered', 'exhausted_iterations', 'error')),
  -- Last successfully observed OpenRouter completion id for the run (its
  -- streaming chunks' top-level `id`, e.g. "chatcmpl-..."), NOT an HTTP
  -- request-correlation id. May be the id of a preceding successful
  -- tool-producing iteration even on an 'error' row, if a later provider
  -- call failed before yielding any stream data to observe an id from.
  provider_completion_id text,
  created_at timestamptz not null default now(),
  constraint agent_audit_log_agent_run_id_key unique (agent_run_id),
  constraint agent_audit_log_tool_call_count_check check (tool_call_count >= 0),
  constraint agent_audit_log_latency_ms_check check (latency_ms >= 0)
);

create index agent_audit_log_user_created_idx
on public.agent_audit_log (user_id, created_at desc);

-- No retention job -- matches agent_usage_log's precedent (meant for
-- longer-term analysis), not agent_chat_requests's 1-day rate-limit ledger.
alter table public.agent_audit_log enable row level security;
alter table public.agent_audit_log force row level security;

create policy agent_audit_log_select_own
on public.agent_audit_log
for select
to authenticated
using ((select auth.uid()) = user_id);

grant select on public.agent_audit_log to authenticated;
revoke insert, update, delete on public.agent_audit_log from authenticated;
revoke all on public.agent_audit_log from anon;
