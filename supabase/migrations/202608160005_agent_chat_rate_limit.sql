-- Minimal request log for rate-limiting agent-cloud-chat. BYOK means a
-- runaway loop burns the user's own OpenRouter balance, not this backend's,
-- but that's still worth capping by default. Service-role only: the edge
-- function is the sole writer/reader, the client never touches this table.
create table public.agent_chat_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index agent_chat_requests_user_created_idx
on public.agent_chat_requests (user_id, created_at desc);

alter table public.agent_chat_requests enable row level security;
alter table public.agent_chat_requests force row level security;
-- No policies for `authenticated` -- service-role only, by omission,
-- matching google_calendar_connections/user_api_keys.

-- Keeps the table from growing unbounded; a day of history is more than
-- enough for an hourly rolling-window check.
select cron.schedule(
  'agent-chat-requests-cleanup',
  '0 * * * *',
  $$ delete from public.agent_chat_requests where created_at < now() - interval '1 day'; $$
);
