// Multi-model comparison runner for the agent-v0 corpus. Runs `runEval()`
// (eval/run.ts) once per model against the same fixtures, and reports
// pass/fail/manual-review plus cost/token/latency per model side by side.
//
// Never run in CI: needs a real logged-in user's Supabase access token
// (SUPABASE_ACCESS_TOKEN, dedicated eval account) with an OpenRouter key
// already connected -- every call spends real OpenRouter credits, and a
// full 5-model comparison against the 38-fixture corpus is ~190 requests.
//
// Requires the eval account to have an elevated, explicitly-configured
// rate limit on the backend (MEMDO_EVAL_RATE_LIMIT_ENABLED=true and
// MEMDO_EVAL_RATE_LIMIT_PER_HOUR set above 30 -- see
// agent-cloud-contract.ts's resolveRateLimitPerHour) -- otherwise the
// default 30/hour limit gets hit partway through the first model. Hitting
// the limit mid-comparison is expected, not a bug: this script does not
// auto-retry or sleep past a 429. It stops the whole comparison at that
// point, saves the partial results for every model run so far (including
// the one that got rate-limited), and does not run the remaining models.
//
// IMPORTANT: cost/token accounting is attributed by reading agent_usage_log
// rows newer than a per-model watermark. Do not run anything else against
// this same eval account (manual app usage, another `eval`/`eval:compare`
// run) while this script is running -- concurrent calls to the same model
// would mix their usage into this run's totals. See the memdo repo's
// eval/agent-v0/README.md for the full precondition.
//
// Run `npm run eval:seed` first, same prerequisite as `npm run eval`.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_ACCESS_TOKEN=... \
//     deno run --allow-net --allow-read --allow-env --allow-write eval/compare.ts \
//     [--models <comma-separated ids>] [--fixtures <dir>] [--json <path>]
//
// or: npm run eval:compare

import { ALLOWED_OPENROUTER_MODELS } from '../supabase/functions/_shared/agent-cloud-contract.ts'
import { runEval } from './run.ts'

type RestOpts = { baseUrl: string; publishableKey: string; accessToken: string }

// The watermark is an opaque, monotonically increasing DB identifier, not a
// number to do arithmetic on -- agent_usage_log.id is Postgres bigint,
// whose range exceeds JS's safe-integer range. Kept as a string end to
// end: fetched via `select=id::text` so PostgREST casts it to text before
// serializing (avoiding a JS-number round trip that could already lose
// precision), and only ever used in an `id=gt.<value>` query string, never
// added or subtracted.
type UsageId = string

async function fetchUsageWatermark(opts: RestOpts): Promise<UsageId> {
  const url = `${opts.baseUrl}/rest/v1/agent_usage_log?select=id::text&order=id.desc&limit=1`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.accessToken}`, apikey: opts.publishableKey },
  })
  if (!res.ok) throw new Error(`failed to read usage watermark: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error('invalid agent usage watermark response')
  const id = (rows[0] as { id?: unknown } | undefined)?.id
  if (id === undefined) return '0'
  if (typeof id !== 'string') throw new Error('invalid agent usage watermark id')
  return id
}

async function fetchUsageSince(
  opts: RestOpts & { model: string; afterId: UsageId },
): Promise<
  { costUsd: number; promptTokens: number; completionTokens: number; requestCount: number }
> {
  const url = `${opts.baseUrl}/rest/v1/agent_usage_log` +
    `?select=cost_usd,prompt_tokens,completion_tokens` +
    `&id=gt.${encodeURIComponent(opts.afterId)}` +
    `&model=eq.${encodeURIComponent(opts.model)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.accessToken}`, apikey: opts.publishableKey },
  })
  if (!res.ok) throw new Error(`failed to fetch agent usage: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error('invalid agent usage response')
  const typed = rows as { cost_usd: string; prompt_tokens: number; completion_tokens: number }[]
  return {
    costUsd: typed.reduce((sum, r) => sum + Number(r.cost_usd), 0),
    promptTokens: typed.reduce((sum, r) => sum + r.prompt_tokens, 0),
    completionTokens: typed.reduce((sum, r) => sum + r.completion_tokens, 0),
    requestCount: typed.length,
  }
}

export type ModelComparison = {
  model: string
  pass: number
  fail: number
  manualReview: number
  fixtureCount: number
  completedCount: number
  rateLimited: boolean
  elapsedMs: number
  avgFixtureWallMs: number | null
  costUsd: number
  promptTokens: number
  completionTokens: number
  requestCount: number
}

function parseArgs(argv: string[]) {
  const args: { models?: string; fixtures?: string; json?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--models') args.models = argv[++i]
    else if (argv[i] === '--fixtures') args.fixtures = argv[++i]
    else if (argv[i] === '--json') args.json = argv[++i]
  }
  return args
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) {
    console.error(`Missing required environment variable: ${name}`)
    console.error("See eval/compare.ts's header comment for full usage.")
    Deno.exit(1)
  }
  return value
}

async function main() {
  const args = parseArgs(Deno.args)
  const fixturesDir = args.fixtures ?? '../memdo/eval/agent-v0'

  const models = args.models ? args.models.split(',') : [...ALLOWED_OPENROUTER_MODELS]
  const unknown = models.filter((m) =>
    !(ALLOWED_OPENROUTER_MODELS as readonly string[]).includes(m)
  )
  if (unknown.length > 0) {
    console.error(`Unknown model(s): ${unknown.join(', ')}`)
    console.error(`Allowed models: ${ALLOWED_OPENROUTER_MODELS.join(', ')}`)
    Deno.exit(1)
  }

  const baseUrl = requiredEnv('SUPABASE_URL')
  const publishableKey = requiredEnv('SUPABASE_PUBLISHABLE_KEY')
  const accessToken = requiredEnv('SUPABASE_ACCESS_TOKEN')

  console.log(`Comparing ${models.length} model(s) against ${fixturesDir}: ${models.join(', ')}\n`)

  const comparisons: ModelComparison[] = []
  let stoppedEarly = false

  for (const model of models) {
    console.log(`── ${model} ──`)
    const usageAfterId = await fetchUsageWatermark({ baseUrl, publishableKey, accessToken })
    const startWall = performance.now()
    const report = await runEval({ fixturesDir, model, baseUrl, publishableKey, accessToken })
    const elapsedMs = performance.now() - startWall

    // Not caught -- a failure here throws and aborts the whole comparison:
    // cost data is the point of this tool, "couldn't read usage" must
    // never quietly become "$0".
    const usage = await fetchUsageSince({
      baseUrl,
      publishableKey,
      accessToken,
      model,
      afterId: usageAfterId,
    })

    // Invariant: one usage row per completed fixture, no more, no fewer.
    // agent-cloud-chat/index.ts inserts into agent_usage_log after a
    // successful provider call but swallows an insert failure (logs it,
    // still closes the stream normally) -- so a completed fixture can, in
    // rare cases, produce zero usage rows. Silently reporting a lower
    // requestCount/costUsd than what actually happened would make this
    // tool's core output quietly wrong. This also catches drift from the
    // "don't run anything else against this account concurrently" rule --
    // a stray concurrent call to the same model shows up as
    // requestCount > completedCount. Holds for partial/rate-limited runs
    // too: N completed fixtures before a 429 must have produced exactly N
    // usage rows.
    if (usage.requestCount !== report.completedCount) {
      throw new Error(
        `agent usage is incomplete for ${model}: ` +
          `expected ${report.completedCount} usage rows, got ${usage.requestCount}`,
      )
    }

    // avgFixtureWallMs, not avgLatencyMs -- this is wall-clock time per
    // fixture as observed by this script (network + backend + provider +
    // our own grading), not the provider's actual model latency. null (not
    // 0) when completedCount is 0 -- e.g. the very first fixture 429s (a
    // real, expected case: the rate-limit gate reads the last rolling
    // hour, so a prior run's requests can still be sitting in that window)
    // -- "average of zero completed fixtures" isn't a 0ms average, it's
    // undefined.
    const avgFixtureWallMs = report.completedCount > 0 ? elapsedMs / report.completedCount : null

    const comparison: ModelComparison = {
      model,
      ...report.summary,
      fixtureCount: report.fixtureCount,
      completedCount: report.completedCount,
      rateLimited: report.rateLimited,
      elapsedMs,
      avgFixtureWallMs,
      ...usage,
    }
    comparisons.push(comparison)
    console.log(
      `  pass: ${comparison.pass}  fail: ${comparison.fail}  manual-review: ${comparison.manualReview}` +
        `  (${comparison.completedCount}/${comparison.fixtureCount} completed)` +
        `  cost: $${comparison.costUsd.toFixed(4)}\n`,
    )

    if (report.rateLimited) {
      console.error(
        `Rate-limited after ${report.completedCount}/${report.fixtureCount} for ${model} -- ` +
          `stopping the whole comparison here, not running remaining models.`,
      )
      stoppedEarly = true
      break
    }
  }

  console.log('── Comparison ──\n')
  console.table(
    comparisons.map((c) => ({
      model: c.model,
      pass: c.pass,
      fail: c.fail,
      manualReview: c.manualReview,
      completed: `${c.completedCount}/${c.fixtureCount}`,
      rateLimited: c.rateLimited,
      avgFixtureWallMs: c.avgFixtureWallMs === null ? null : Math.round(c.avgFixtureWallMs),
      costUsd: c.costUsd.toFixed(4),
      promptTokens: c.promptTokens,
      completionTokens: c.completionTokens,
    })),
  )
  if (stoppedEarly) {
    console.log('\nStopped early due to rate limiting -- see above for which model.')
  }

  if (args.json) {
    const output = {
      run: { executedAt: new Date().toISOString(), corpus: 'agent-v0', models, stoppedEarly },
      comparisons,
    }
    await Deno.writeTextFile(args.json, JSON.stringify(output, null, 2))
    console.log(`\nWrote full results to ${args.json}`)
  }
}

if (import.meta.main) {
  await main()
}
