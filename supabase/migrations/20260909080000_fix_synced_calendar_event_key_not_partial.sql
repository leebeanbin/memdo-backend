-- google_calendar_mirror_events_synced_calendar_event_key was created as a
-- PARTIAL unique index (where synced_calendar_id is not null). PostgREST's
-- upsert onConflict option (used by pullCalendarIntoMirror for every
-- additional synced calendar -- see _shared/google-calendar-contract.ts)
-- generates a plain `ON CONFLICT (synced_calendar_id, google_event_id)`
-- with no WHERE clause, and Postgres can only infer a conflict target from
-- a partial index when the ON CONFLICT clause repeats its exact predicate --
-- a bare column-list target can never match one. Every sync of every
-- additional calendar has therefore failed with 42P10 ("no unique or
-- exclusion constraint matching the ON CONFLICT specification") since this
-- feature shipped (found live: a subscribed "대한민국의 휴일" holiday
-- calendar had pulled zero events, ever).
--
-- Dropping the partial predicate changes nothing about which rows are
-- protected: a plain (non-partial) unique index on these two columns still
-- lets every synced_calendar_id IS NULL (primary-calendar) row coexist
-- freely, because SQL unique constraints already treat every NULL as
-- distinct from every other NULL -- the WHERE clause was never load-bearing
-- for that, only for matching PostgREST's inference, which it now breaks
-- instead of enabling.
drop index public.google_calendar_mirror_events_synced_calendar_event_key;

create unique index google_calendar_mirror_events_synced_calendar_event_key
on public.google_calendar_mirror_events (synced_calendar_id, google_event_id);
