-- Recurrence redesign: rules no longer bulk-materialize up to 200 future occurrences
-- at creation time (which silently stopped producing new ones once the cap or a
-- 365-day horizon was hit). task-mode rules now materialize one occurrence at a
-- time (next one created on completion); event-mode rules materialize none at all
-- (occurrences are computed on demand for whatever range is queried, matching how
-- Google Calendar/Outlook/RFC 5545 treat recurring events).
--
-- timezone_offset_minutes was only ever used transiently at rule-creation time to
-- compute the initial batch's start_at/end_at, never persisted -- so materializing
-- occurrences later (on completion, or when a virtual occurrence is touched) had no
-- way to reconstruct local wall-clock times. Persist it on the rule itself.
alter table public.schedule_rules
  add column timezone_offset_minutes integer not null default 540;

alter table public.schedule_rules
  add constraint schedule_rules_timezone_offset_check
  check (timezone_offset_minutes between -720 and 840);
