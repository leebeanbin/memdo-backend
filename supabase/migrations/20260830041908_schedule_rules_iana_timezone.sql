-- bd16: schedule_rules.timezone_offset_minutes was a fixed integer captured
-- once at rule-creation time, then reused unchanged for every future
-- occurrence's start_at/end_at computation. Correct for a timezone with no
-- DST (Asia/Seoul, this app's only real userbase so far), silently wrong
-- for any timezone that observes one -- an event created in August (PDT,
-- UTC-7) still used that same -7 offset for its January occurrence
-- (should be PST, UTC-8), landing every occurrence an hour off across the
-- transition.
--
-- Replaced with an IANA timezone name (matching user_preferences.timezone's
-- existing type/default) -- offsets are now computed per-occurrence-date
-- from this via Intl, so each occurrence gets its own DST-correct offset
-- instead of one frozen at creation time.
--
-- Pre-launch/dogfooding data only (no external users yet), so a blanket
-- 'Asia/Seoul' backfill for existing rows is accurate for every real row
-- today -- there is no user outside KST to backfill incorrectly for.
alter table public.schedule_rules
  add column timezone text not null default 'Asia/Seoul';

alter table public.schedule_rules
  add constraint schedule_rules_timezone_check check (char_length(timezone) between 1 and 100);

alter table public.schedule_rules
  drop constraint if exists schedule_rules_timezone_offset_check;

alter table public.schedule_rules
  drop column if exists timezone_offset_minutes;
