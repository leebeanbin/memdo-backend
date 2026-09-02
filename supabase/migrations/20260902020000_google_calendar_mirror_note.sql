-- The pull path never captured a Google event's description at all --
-- mapGoogleEventToMirrorRow only mapped title/time/location, so a
-- Google-sourced item's memo was silently empty in Memdo even though the
-- push path already sends description when Memdo -> Google (toGoogleEventBody).
-- Found live: user reported Google Calendar notes missing in schedule detail.
alter table public.google_calendar_mirror_events
  add column note text;
