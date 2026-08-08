-- 202608080001 was generated from `supabase db diff` output and, alongside the intended
-- service_role grants, also (a) granted full DML to anon and (b) re-granted delete on
-- user_preferences/daily_reviews to authenticated, reversing deliberate restrictions from
-- 202608030003 and 202608050003. RLS currently blocks anon from exploiting (a), but it
-- removes a defense-in-depth layer that every Edge Function query relies on (none of them
-- filter by user_id themselves). (b) makes preferences/index.ts's GET .single() 500 once a
-- user deletes their own row.
revoke all on table
  public.users,
  public.user_calendars,
  public.todos,
  public.user_preferences,
  public.schedule_rules,
  public.daily_reviews
from anon;

revoke delete on table public.user_preferences, public.daily_reviews from authenticated;
