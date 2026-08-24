// Seeds the deterministic eval-account fixtures eval/agent-v0's
// PROPOSE_SCHEDULE_UPDATE cases (search-005/006) need to exist -- a
// dedicated, explicit step, not something run.ts does automatically before
// every eval run. Run this once before `npm run eval` (or again any time
// you want to restore the seeded rows to their baseline values).
//
// Needs the same SUPABASE_ACCESS_TOKEN as run.ts, belonging to the
// dedicated eval account (MEMDO_EVAL_ACCOUNT_USER_ID on the backend) with
// MEMDO_EVAL_SEED_ENABLED=true set on that deployment. Does NOT touch any
// other data in that account -- see eval-seed-contract.ts's doc comment.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_ACCESS_TOKEN=... \
//     deno run --allow-net --allow-env eval/seed.ts
//
// or: npm run eval:seed

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) {
    console.error(`Missing required environment variable: ${name}`)
    console.error("See eval/seed.ts's header comment for full usage.")
    Deno.exit(1)
  }
  return value
}

async function main() {
  const baseUrl = requiredEnv('SUPABASE_URL')
  const publishableKey = requiredEnv('SUPABASE_PUBLISHABLE_KEY')
  const accessToken = requiredEnv('SUPABASE_ACCESS_TOKEN')

  const localDate = new Date().toISOString().slice(0, 10)
  const response = await fetch(`${baseUrl}/functions/v1/eval-bootstrap`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: publishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ localDate }),
  })
  const body = await response.text()
  if (!response.ok) {
    console.error(`eval-bootstrap ${response.status}: ${body}`)
    Deno.exit(1)
  }
  console.log(`Seeded eval account fixtures for ${localDate}: ${body}`)
}

if (import.meta.main) {
  await main()
}
