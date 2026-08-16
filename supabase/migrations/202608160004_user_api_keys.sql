-- BYOK (bring-your-own-key) storage for cloud Agent providers, starting
-- with OpenRouter. Same shape as google_calendar_connections: the raw key
-- lives in Vault (referenced here by secret id), this table is otherwise
-- service-role only for writes, and RLS scopes reads to the owner so the
-- client can show connection status without ever seeing the key back.
create table public.user_api_keys (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null,
  secret_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_api_keys_user_provider_key unique (user_id, provider),
  constraint user_api_keys_provider_check check (provider in ('openrouter'))
);

create trigger user_api_keys_set_updated_at
before update on public.user_api_keys
for each row execute function public.set_updated_at();

alter table public.user_api_keys enable row level security;
alter table public.user_api_keys force row level security;

create policy user_api_keys_owner_select_policy
on public.user_api_keys
for select to authenticated
using (user_id = (select auth.uid()));

grant select on public.user_api_keys to authenticated;
