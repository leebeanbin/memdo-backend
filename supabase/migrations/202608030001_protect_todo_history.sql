-- Client JWTs may update deleted_at through the API, but cannot bypass history with hard DELETE.
revoke delete on table public.todos from authenticated;
