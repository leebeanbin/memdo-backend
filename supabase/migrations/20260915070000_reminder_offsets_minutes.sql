-- R1-1 (Reminder v2): canonical reminder_offsets_minutes array, additive
-- alongside the existing scalar reminder_offset_minutes -- the scalar stays
-- untouched throughout the R1 bridge window (see R1-2's dual-read/dual-write
-- contract) and is only dropped once the whole epic's compatibility window
-- closes.
--
-- Validated with a real CHECK constraint (not left to the Zod layer alone,
-- despite an earlier review note here suggesting otherwise) -- matches this
-- table's own established convention: ~12 other per-field CHECK constraints
-- already enforce this exact class of business rule (todos_reminder_offset_check
-- range-checks the scalar this migration is superseding), so a business
-- rule living only in application code would be the inconsistent choice
-- here, not the safe default.
--
-- Full invariant is 0-5 items, each 0-10080 minutes, no duplicates,
-- ascending order -- but Postgres flatly rejects a subquery inside a CHECK
-- constraint ("cannot use subquery in check constraint", confirmed against
-- a local db reset while writing this), which rules out the
-- unnest()-into-aggregate approach a duplicate/sortedness check would
-- naturally need. Cardinality and per-element range ARE expressible
-- without a subquery via the ALL/ANY array quantifiers (standard SQL:
-- `x <= ALL(array)` is vacuously true for an empty array, so '{}' -- "no
-- reminders" -- needs no special-casing here), so those two are enforced
-- at the DB level, matching this table's style of a single inline boolean
-- clause per constraint. No-duplicates and ascending-order are set/sequence
-- properties that would need either a subquery or a separate stored
-- function to express in SQL -- neither matches this table's existing
-- convention (every other constraint here is a plain boolean expression,
-- none reference a function), so those two are enforced by R1-2's Zod
-- schema instead, which already sorts on the way in (so "ascending" is
-- true by construction, not just validated) and rejects duplicates
-- via superRefine.
alter table public.todos
add column reminder_offsets_minutes integer[] not null default '{}';

alter table public.todos add constraint todos_reminder_offsets_check check (
  cardinality(reminder_offsets_minutes) <= 5
  and 0 <= all(reminder_offsets_minutes)
  and 10080 >= all(reminder_offsets_minutes)
);

alter table public.schedule_rules
add column reminder_offsets_minutes integer[] not null default '{}';

alter table public.schedule_rules add constraint schedule_rules_reminder_offsets_check check (
  cardinality(reminder_offsets_minutes) <= 5
  and 0 <= all(reminder_offsets_minutes)
  and 10080 >= all(reminder_offsets_minutes)
);

-- Backfill: order doesn't need to reconstruct real history, only produce a
-- valid array from the existing scalar -- a one-time conversion, not an
-- ongoing sync (R1-2's application code is the ongoing dual-write path).
update public.todos
set reminder_offsets_minutes =
  case when reminder_offset_minutes is null
    then '{}'::integer[]
    else array[reminder_offset_minutes]
  end
where reminder_offsets_minutes = '{}';

update public.schedule_rules
set reminder_offsets_minutes =
  case when reminder_offset_minutes is null
    then '{}'::integer[]
    else array[reminder_offset_minutes]
  end
where reminder_offsets_minutes = '{}';
