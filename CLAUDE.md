# ⚠️ This is the canonical memdo-backend checkout

**Path**: `~/Developer/wlrma/memdo-backend`

This checkout's `HEAD` matches `origin/main` on GitHub. It also carries
substantial uncommitted local work beyond that commit — including the Google
Calendar two-way sync feature (push queue, materialize-on-edit, real-time
webhook pull) done 2026-09-02 — which has already been:
- Applied to the linked Supabase project (`snfvykovzybfpwomnxhj`) via
  migrations, and
- Deployed as the live Edge Functions.

**Always run `supabase db push` / `supabase functions deploy` from this path.**

## Known duplicate checkout — do not deploy from it

`~/Documents/Codex/2026-07-30/wlrma/memdo-backend` is on the *same* base
commit as this one, but is **missing all of the uncommitted local work
described above** (categories/bd18 work and the entire two-way-sync feature).
It is also this Claude Code session's own working-directory root, so it isn't
being deleted -- but **deploying Edge Functions or pushing migrations from
that path would silently regress the live backend** back to a much older
state. If working from that path for any reason, `diff` the relevant files
against this checkout first.
