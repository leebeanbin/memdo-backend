-- Stores the Apple Sign In refresh token needed to call POST
-- https://appleid.apple.com/auth/revoke at account-deletion time (Epic L).
-- Same shape/security model as google_calendar_connections
-- (202608090004_google_calendar_mirror.sql): the refresh token itself lives
-- in Vault (referenced here by secret id), only apple-auth-token-exchange
-- and account (both service role) write to it. RLS grants the owner a
-- read of refresh_token_secret_id -- just a Vault row id, useless without
-- the service-role-only vault_* RPCs, same reasoning as
-- google_calendar_connections' own owner-select policy.
create table public.apple_oauth_tokens (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  refresh_token_secret_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint apple_oauth_tokens_user_id_key unique (user_id)
);

create trigger apple_oauth_tokens_set_updated_at
before update on public.apple_oauth_tokens
for each row execute function public.set_updated_at();

alter table public.apple_oauth_tokens enable row level security;
alter table public.apple_oauth_tokens force row level security;

create policy apple_oauth_tokens_owner_select_policy
on public.apple_oauth_tokens
for select to authenticated
using (user_id = (select auth.uid()));

grant select on public.apple_oauth_tokens to authenticated;
