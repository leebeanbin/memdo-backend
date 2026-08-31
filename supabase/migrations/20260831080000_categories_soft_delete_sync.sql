-- bd26: for /sync to report category deletions at all, user_categories
-- needs to adopt the same soft-delete (deleted_at) convention todos/
-- schedule_rules already use -- PUT /categories currently prunes rows not
-- in the replacement list via a real hard DELETE, which leaves no
-- tombstone to sync.
alter table public.user_categories add column deleted_at timestamptz;

-- Matches todos'/schedule_rules' established convention (202608030001,
-- 20260831050000): once the API stops issuing real DELETEs, revoke the
-- privilege so a client can't bypass the soft-delete/sync tombstone with
-- direct PostgREST access.
revoke delete on table public.user_categories from authenticated;

alter table public.user_categories add column sync_seq bigint;
update public.user_categories set sync_seq = nextval('public.sync_seq') where sync_seq is null;
alter table public.user_categories alter column sync_seq set not null;
create index user_categories_sync_seq_idx on public.user_categories (sync_seq);
create trigger user_categories_set_sync_seq
before insert or update on public.user_categories
for each row execute function public.set_sync_seq();
