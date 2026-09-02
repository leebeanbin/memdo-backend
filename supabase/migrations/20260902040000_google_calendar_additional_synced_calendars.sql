-- General "add other Google calendars" support (holiday calendars, a
-- secondary personal calendar, etc.) -- previously a connection only ever
-- synced its one `google_calendar_id` ('primary'). Deliberately additive:
-- the primary calendar keeps using google_calendar_connections' own
-- sync_token/color_token/last_synced_at exactly as before (unchanged, no
-- backfill/migration risk); each *additional* calendar the user opts into
-- gets its own row here with its own independent sync_token, so one
-- calendar's incremental sync never affects another's. Additional calendars
-- are pull-only (no push/materialize -- a subscribed public holiday
-- calendar isn't writable by the subscriber anyway) and covered by the
-- existing 15-min google-calendar-sync cron only, not the real-time
-- webhook -- a holiday calendar essentially never changes, so per-calendar
-- watch-channel plumbing isn't worth the added complexity here.
create table public.google_calendar_synced_calendars (
  id uuid primary key default extensions.gen_random_uuid(),
  connection_id uuid not null references public.google_calendar_connections(id) on delete cascade,
  google_calendar_id text not null,
  summary text not null,
  color_token text,
  sync_token text,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_calendar_synced_calendars_connection_calendar_key
    unique (connection_id, google_calendar_id)
);

create trigger google_calendar_synced_calendars_set_updated_at
before update on public.google_calendar_synced_calendars
for each row execute function public.set_updated_at();

-- Nullable: null means "this row is from the connection's primary calendar"
-- (unchanged existing behavior, keyed by connection_id alone as before);
-- set means "this row is from one of the additional calendars below".
alter table public.google_calendar_mirror_events
  add column synced_calendar_id uuid references public.google_calendar_synced_calendars(id) on delete cascade;

-- The existing (connection_id, google_event_id) unique constraint already
-- covers every synced_calendar_id-null (primary-calendar) row -- Postgres
-- treats every NULL as distinct for uniqueness purposes, so it never
-- applies across two different calendars' rows anyway. This partial index
-- is what actually protects an additional calendar's own rows from
-- duplicating on a re-sync.
create unique index google_calendar_mirror_events_synced_calendar_event_key
on public.google_calendar_mirror_events (synced_calendar_id, google_event_id)
where synced_calendar_id is not null;

create index google_calendar_synced_calendars_connection_idx
on public.google_calendar_synced_calendars (connection_id);
