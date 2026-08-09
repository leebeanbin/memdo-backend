create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Vault lives in the `vault` schema, which PostgREST never exposes. These
-- thin wrappers are the only way an edge function (talking to Postgres
-- exclusively through PostgREST/RPC) can create, rotate, or read a secret --
-- and they are service-role only, so a leaked anon/authenticated key still
-- can't read anyone's refresh token.
create function public.vault_create_secret(p_secret text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := vault.create_secret(p_secret, p_name);
  return v_id;
end;
$$;

create function public.vault_update_secret(p_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform vault.update_secret(p_id, p_secret);
end;
$$;

create function public.vault_read_secret(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = p_id;
  return v_secret;
end;
$$;

create function public.vault_delete_secret(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = p_id;
end;
$$;

revoke execute on function public.vault_create_secret(text, text) from public, authenticated, anon;
revoke execute on function public.vault_update_secret(uuid, text) from public, authenticated, anon;
revoke execute on function public.vault_read_secret(uuid) from public, authenticated, anon;
revoke execute on function public.vault_delete_secret(uuid) from public, authenticated, anon;
grant execute on function public.vault_create_secret(text, text) to service_role;
grant execute on function public.vault_update_secret(uuid, text) to service_role;
grant execute on function public.vault_read_secret(uuid) to service_role;
grant execute on function public.vault_delete_secret(uuid) to service_role;

-- One Google Calendar connection per user. Tokens never leave the server:
-- the refresh token lives in Vault (referenced here by secret id) and this
-- table itself is service-role only -- no grants, no policies for
-- `authenticated`, so PostgREST can never surface it even by accident.
create table public.google_calendar_connections (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  google_calendar_id text not null default 'primary',
  refresh_token_secret_id uuid not null,
  scope text not null default 'https://www.googleapis.com/auth/calendar.readonly',
  status text not null default 'active',
  sync_token text,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_calendar_connections_user_id_key unique (user_id),
  constraint google_calendar_connections_status_check check (
    status in ('active', 'revoked', 'error')
  )
);

create trigger google_calendar_connections_set_updated_at
before update on public.google_calendar_connections
for each row execute function public.set_updated_at();

-- Read-only mirror of the connected Google Calendar's events. Never written
-- to by the client; only google-calendar-sync (service role) populates it.
create table public.google_calendar_mirror_events (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  connection_id uuid not null references public.google_calendar_connections(id) on delete cascade,
  google_event_id text not null,
  title text not null,
  is_all_day boolean not null default false,
  start_at timestamptz not null,
  end_at timestamptz not null,
  location_name text,
  google_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_calendar_mirror_events_connection_event_key
    unique (connection_id, google_event_id),
  constraint google_calendar_mirror_events_time_order_check check (end_at > start_at)
);

create index google_calendar_mirror_events_user_range_idx
on public.google_calendar_mirror_events (user_id, start_at, end_at);

create trigger google_calendar_mirror_events_set_updated_at
before update on public.google_calendar_mirror_events
for each row execute function public.set_updated_at();

-- Short-lived, single-use nonce binding an OAuth `state` to the user who
-- started the flow. Service-role only: the callback has no user JWT to
-- authenticate with (Google calls it directly), so this is how it recovers
-- "who asked for this".
create table public.google_calendar_oauth_states (
  state text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

alter table public.google_calendar_connections enable row level security;
alter table public.google_calendar_connections force row level security;
alter table public.google_calendar_mirror_events enable row level security;
alter table public.google_calendar_mirror_events force row level security;
alter table public.google_calendar_oauth_states enable row level security;
alter table public.google_calendar_oauth_states force row level security;

-- Mirror rows are readable by their owner (shown in the calendar view);
-- everything else about this feature is service-role only by omission.
create policy google_calendar_mirror_events_owner_select_policy
on public.google_calendar_mirror_events
for select to authenticated
using (user_id = (select auth.uid()));

-- The client needs to read connection status (GET /calendars synthesizes a
-- "Google Calendar" entry from this row) but never writes it directly --
-- only google-calendar-start/-callback/-disconnect (service role) do. The
-- one column this exposes that isn't already client-visible elsewhere is
-- refresh_token_secret_id, which is just a Vault row id: useless without the
-- service-role-only RPCs in this migration, so it carries no real secret.
create policy google_calendar_connections_owner_select_policy
on public.google_calendar_connections
for select to authenticated
using (user_id = (select auth.uid()));

grant usage on schema public to authenticated;
grant select on public.google_calendar_mirror_events to authenticated;
grant select on public.google_calendar_connections to authenticated;

select cron.schedule(
  'google-calendar-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://snfvykovzybfpwomnxhj.supabase.co/functions/v1/google-calendar-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'google_calendar_sync_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'google-calendar-oauth-states-cleanup',
  '0 * * * *',
  $$ delete from public.google_calendar_oauth_states where expires_at < now(); $$
);
