-- Real-time pull via Google Calendar push notifications (webhooks), layered
-- on top of the existing 15-min pull cron (which stays as the fallback for
-- any missed/expired-channel window -- never removed).
alter table public.google_calendar_connections
  add column watch_channel_id text,
  add column watch_resource_id text,
  add column watch_expiration timestamptz,
  -- Echoed back by Google on every notification (X-Goog-Channel-Token) --
  -- the only way to verify a webhook request actually originated from the
  -- channel we registered, since Google does not sign these requests.
  add column watch_token text;

-- Renew a channel before it expires (Google's own docs give no fixed
-- max/default for the Events resource -- we request a conservative 7-day
-- expiration ourselves and renew daily, well inside any undocumented
-- limit). Reuses GOOGLE_CALENDAR_SYNC_SECRET, the same internal-cron-auth
-- secret every other Google Calendar cron in this project already uses.
select cron.schedule(
  'google-calendar-watch-renew',
  '0 3 * * *',
  $$
  select net.http_post(
    url := 'https://snfvykovzybfpwomnxhj.supabase.co/functions/v1/google-calendar-watch-renew',
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
