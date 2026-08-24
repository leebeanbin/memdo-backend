// Manual eval runner for the agent-v0 corpus (memdo/eval/agent-v0/*.jsonl).
// Never run in CI: needs a real logged-in user's Supabase access token
// (SUPABASE_ACCESS_TOKEN) with an OpenRouter key already connected via the
// app's agent-key flow -- every call spends real OpenRouter credits.
//
// Run `npm run eval:seed` (eval/seed.ts) first -- PROPOSE_SCHEDULE_UPDATE
// fixtures (search-005/006) need the prerequisite rows it seeds to exist.
// That only guarantees those specific rows, not that the whole account is
// otherwise clean (see eval-seed-contract.ts's doc comment on the backend).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_ACCESS_TOKEN=... \
//     deno run --allow-net --allow-read --allow-env --allow-write eval/run.ts [--fixtures <dir>] [--model <id>] [--json <path>]
//
// or: npm run eval -- --model openai/gpt-5.4-mini

import { type DispatchedTool, type EvalFixture, gradeCase, type GradeVerdict } from './grade.ts'

const DEFAULT_MODEL = 'openai/gpt-5.4-mini'

type CaseResult = {
  fixture: EvalFixture
  verdict: GradeVerdict
  reason: string
  dispatchedTools: DispatchedTool[]
  assistantText: string
}

/** Distinguishes a 429 from every other failure mode -- runEval() treats
 * this one specially (stop the whole run, don't grade the rest), while any
 * other error still propagates and fails the run outright. */
export class RateLimitedError extends Error {}

export type EvalReport = {
  model: string
  fixtureCount: number
  completedCount: number
  rateLimited: boolean
  results: CaseResult[]
  summary: { pass: number; fail: number; manualReview: number }
}

function parseArgs(argv: string[]) {
  const args: { fixtures?: string; model?: string; json?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixtures') args.fixtures = argv[++i]
    else if (argv[i] === '--model') args.model = argv[++i]
    else if (argv[i] === '--json') args.json = argv[++i]
  }
  return args
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) {
    console.error(`Missing required environment variable: ${name}`)
    console.error("See eval/run.ts's header comment for full usage.")
    Deno.exit(1)
  }
  return value
}

async function loadFixtures(dir: string): Promise<EvalFixture[]> {
  let entries: Deno.DirEntry[]
  try {
    entries = [...Deno.readDirSync(dir)]
  } catch {
    console.error(`Could not read fixtures directory: ${dir}`)
    console.error(
      'Default assumes memdo-backend and memdo are cloned as sibling directories -- pass --fixtures <dir> if yours are laid out differently.',
    )
    Deno.exit(1)
  }
  const fixtures: EvalFixture[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue
    const text = await Deno.readTextFile(`${dir}/${entry.name}`)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      fixtures.push(JSON.parse(line))
    }
  }
  return fixtures
}

/** POSTs one fixture's input to the deployed agent-cloud-chat function and
 * parses its NDJSON response into dispatchedTools + the concatenated
 * assistant text. No history -- every fixture is evaluated as a fresh
 * conversation, matching the corpus README's "paste each input in, one at a
 * time, in a fresh conversation" manual-run instructions. */
async function runFixture(
  fixture: EvalFixture,
  opts: { baseUrl: string; publishableKey: string; accessToken: string; model: string },
): Promise<{ dispatchedTools: DispatchedTool[]; assistantText: string }> {
  const response = await fetch(`${opts.baseUrl}/functions/v1/agent-cloud-chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      apikey: opts.publishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: fixture.input, history: [], model: opts.model }),
  })
  if (response.status === 429) {
    throw new RateLimitedError(`agent-cloud-chat 429: ${await response.text().catch(() => '')}`)
  }
  if (!response.ok || !response.body) {
    throw new Error(`agent-cloud-chat ${response.status}: ${await response.text().catch(() => '')}`)
  }

  let assistantText = ''
  let dispatchedTools: DispatchedTool[] = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line)
      if (typeof parsed.delta === 'string') assistantText += parsed.delta
      if (parsed.done) dispatchedTools = parsed.dispatchedTools ?? []
    }
  }
  return { dispatchedTools, assistantText }
}

/** Runs every fixture in fixturesDir against one model and grades each one.
 * A 429 partway through stops the run right there -- that fixture and every
 * fixture after it are excluded entirely from grading and from the summary
 * (never counted as pass/fail), and completedCount/rateLimited report
 * exactly how far the run got. Any other error still propagates and fails
 * the run outright. */
export async function runEval(opts: {
  fixturesDir: string
  model: string
  baseUrl: string
  publishableKey: string
  accessToken: string
}): Promise<EvalReport> {
  const fixtures = await loadFixtures(opts.fixturesDir)
  const results: CaseResult[] = []
  let rateLimited = false
  for (const fixture of fixtures) {
    try {
      const actual = await runFixture(fixture, opts)
      const graded = gradeCase(fixture, actual)
      results.push({ fixture, verdict: graded.verdict, reason: graded.reason, ...actual })
    } catch (error) {
      if (error instanceof RateLimitedError) {
        rateLimited = true
        break
      }
      throw error
    }
  }

  const summary = { pass: 0, fail: 0, manualReview: 0 }
  for (const r of results) {
    if (r.verdict === 'pass') summary.pass++
    else if (r.verdict === 'fail') summary.fail++
    else summary.manualReview++
  }

  return {
    model: opts.model,
    fixtureCount: fixtures.length,
    completedCount: results.length,
    rateLimited,
    results,
    summary,
  }
}

async function main() {
  const args = parseArgs(Deno.args)
  const fixturesDir = args.fixtures ?? '../memdo/eval/agent-v0'
  const model = args.model ?? DEFAULT_MODEL

  const baseUrl = requiredEnv('SUPABASE_URL')
  const publishableKey = requiredEnv('SUPABASE_PUBLISHABLE_KEY')
  const accessToken = requiredEnv('SUPABASE_ACCESS_TOKEN')

  console.log(`Running the agent-v0 corpus from ${fixturesDir} against ${model}...\n`)

  const report = await runEval({ fixturesDir, model, baseUrl, publishableKey, accessToken })

  console.log('── Results ──\n')
  for (const r of report.results) {
    console.log(`[${r.verdict.toUpperCase()}] ${r.fixture.id} (${r.fixture.category}): ${r.reason}`)
    if (r.verdict === 'manual-review') {
      console.log(`  assistantText: ${JSON.stringify(r.assistantText)}`)
    }
  }

  console.log('\n── Summary ──')
  if (report.rateLimited) {
    console.log(
      `Rate-limited after ${report.completedCount}/${report.fixtureCount} fixtures -- run stopped early.`,
    )
  }
  console.log(
    `pass: ${report.summary.pass}  fail: ${report.summary.fail}  manual-review: ${report.summary.manualReview}  (${report.completedCount}/${report.fixtureCount} completed)`,
  )

  if (args.json) {
    const output = {
      run: {
        model,
        executedAt: new Date().toISOString(),
        corpus: 'agent-v0',
        fixtureCount: report.fixtureCount,
        completedCount: report.completedCount,
        rateLimited: report.rateLimited,
      },
      summary: report.summary,
      cases: report.results,
    }
    await Deno.writeTextFile(args.json, JSON.stringify(output, null, 2))
    console.log(`\nWrote full results to ${args.json}`)
  }
}

if (import.meta.main) {
  await main()
}
