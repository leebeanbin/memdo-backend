-- bd20: user_categories.id was globally unique across every user (plain
-- `id uuid primary key`), so a client-generated UUID that happens to
-- already exist as a DIFFERENT user's category (a stale device-local
-- category cache is the realistic path -- see fe14 -- but a network retry
-- or a future bug could reproduce it too) made PUT /categories's
-- upsert(onConflict:'id') try to UPDATE a row it doesn't own. RLS blocks
-- that update, and the endpoint had no specific handling for it (unlike
-- todos' idempotency-key replay path), so it fell through to a raw 500.
-- Making id unique only per-user means two different users can each own a
-- category with the same id without ever colliding -- not just a nicer
-- error, a real elimination of the failure mode.
--
-- Drop and recreate todos_category_user_fkey (bd18) explicitly rather than
-- relying on it silently re-resolving against the new PK: Postgres ties a
-- FK to the specific unique constraint it was created against, and
-- dropping that constraint out from under a still-dependent FK errors.
alter table public.todos drop constraint todos_category_user_fkey;
alter table public.user_categories drop constraint user_categories_id_user_id_key;
alter table public.user_categories drop constraint user_categories_pkey;
alter table public.user_categories add constraint user_categories_pkey primary key (id, user_id);
alter table public.todos
  add constraint todos_category_user_fkey
  foreign key (category_id, user_id)
  references public.user_categories(id, user_id)
  on delete set null;
