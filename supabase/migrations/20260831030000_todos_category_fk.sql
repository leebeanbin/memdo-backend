-- bd18: todos has no relationship to user_categories, so a todo's
-- emoji/color are copied once at creation time and silently drift from the
-- category's current emoji/color after a rename or recolor. Add
-- todos.category_id, enforced same-owner via a composite FK the same way
-- todos_calendar_user_fkey already enforces calendar_id ownership.
alter table public.user_categories
  add constraint user_categories_id_user_id_key unique (id, user_id);

alter table public.todos
  add column category_id uuid;

alter table public.todos
  add constraint todos_category_user_fkey
  foreign key (category_id, user_id)
  references public.user_categories(id, user_id)
  on delete set null;

create index todos_category_id_idx
  on public.todos (category_id)
  where category_id is not null;
