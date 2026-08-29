-- /sync paged on (updated_at, id), but set_updated_at() writes now() --
-- transaction *start* time, not commit time. Two concurrent writes can
-- commit out of timestamp order: a transaction that starts later but
-- commits first advances a client's cursor past a row whose transaction
-- started earlier but is still committing. When that row finally commits
-- (updated_at earlier than the cursor already handed out), it's permanently
-- behind the cursor and never delivered -- exactly the shape an offline
-- outbox flush produces (several queued writes committing back-to-back).
-- Found via founder-dogfooding code review.
--
-- A monotonic sequence assigned inside the same trigger that would have set
-- updated_at doesn't have this problem: nextval() is atomic and only ever
-- handed out once, in true commit order (the row holding a lower sync_seq
-- is guaranteed to have entered its row-level lock, and therefore be
-- either fully committed or destined to roll back, before any row with a
-- higher one can be read by a concurrent transaction).
create sequence if not exists public.todos_sync_seq;

alter table public.todos add column if not exists sync_seq bigint;

-- Backfill: order doesn't need to reconstruct real history, only be a valid
-- total order existing rows didn't have before -- id order is arbitrary but
-- stable, which is all a one-time backfill needs.
update public.todos set sync_seq = nextval('public.todos_sync_seq')
where sync_seq is null;

alter table public.todos alter column sync_seq set not null;

create index if not exists todos_sync_seq_idx on public.todos (sync_seq);

create or replace function public.set_todo_sync_seq()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.sync_seq = nextval('public.todos_sync_seq');
  return new;
end;
$$;

-- Separate trigger from todos_set_updated_at (202608020001_core_schedule.sql)
-- rather than folding into set_updated_at() -- that function is shared by
-- users/user_calendars/todos, and sync_seq is a todos-only, /sync-only
-- concept. BEFORE INSERT too (todos_set_updated_at is UPDATE-only, since
-- updated_at already has a working `default now()` for inserts) -- sync_seq
-- has no equivalent default and must be valid from the row's first commit.
create trigger todos_set_sync_seq
before insert or update on public.todos
for each row execute function public.set_todo_sync_seq();
