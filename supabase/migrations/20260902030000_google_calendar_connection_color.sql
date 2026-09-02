-- Calendar Management's color picker 404'd for the synthetic "Google
-- Calendar" entry -- its id is really google_calendar_connections.id, which
-- has no user_calendars row to PATCH a color onto. Give the connection its
-- own real color_token column instead of disabling the picker.
alter table public.google_calendar_connections
  add column color_token text;
