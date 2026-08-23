-- Supabase project defaults currently grant table DML broadly. RLS would
-- still reject writes because there is no write policy, but this explicit
-- revoke keeps the intended service-role-only write boundary at both layers.
revoke insert, update, delete on public.agent_usage_log from authenticated;
revoke all on public.agent_usage_log from anon;
