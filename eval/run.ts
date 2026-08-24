// Manual eval runner for the agent-v0 corpus (memdo/eval/agent-v0/*.jsonl).
// Never run in CI: needs a real logged-in user's Supabase access token
// (SUPABASE_ACCESS_TOKEN) with an OpenRouter key already connected via the
// app's agent-key flow -- every call spends real OpenRouter credits.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_ACCESS_TOKEN=... \
//     deno run --allow-net --allow-read --allow-env eval/run.ts [--fixtures <dir>] [--model <id>] [--json <path>]
//
// or: npm run eval -- --model openai/gpt-5.4-mini

import { type DispatchedTool, type EvalFixture, gradeCase, type GradeVerdict } from './grade.ts'

export type EvalVerdict = GradeVerdict | 'skipped'

// This Epic doesn't build a deterministic seed/eval account (see
// memdo/eval/agent-v0/README.md's Epic F prerequisite note) -- every
// PROPOSE_SCHEDULE_UPDATE fixture needs a real pre-existing schedule in
// whatever account SUPABASE_ACCESS_TOKEN belongs to, which nothing here can
// guarantee. gradeCase() has no way to tell "no prerequisite data" apart
// from "model failed after finding data" from dispatchedTools alone (it's a
// tool-selection trace, not proof anything was found) -- so this decision
// belongs here, upstream of grading, not inside gradeCase(). Once Epic F
// guarantees deterministic fixture state before each run (not just "an
// account exists" but "it's seeded/reset immediately before this runner
// runs"), this filter can be removed without changing gradeCase() at all.
const STATE_DEPENDENT_BEHAVIORS = new Set(['PROPOSE_SCHEDULE_UPDATE'])

const DEFAULT_MODEL = 'openai/gpt-5.4-mini'

type CaseResult = {
  fixture: EvalFixture
  verdict: EvalVerdict
  reason: string
  dispatchedTools: DispatchedTool[]
  assistantText: string
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

async function main() {
  const args = parseArgs(Deno.args)
  const fixturesDir = args.fixtures ?? '../memdo/eval/agent-v0'
  const model = args.model ?? DEFAULT_MODEL

  const baseUrl = requiredEnv('SUPABASE_URL')
  const publishableKey = requiredEnv('SUPABASE_PUBLISHABLE_KEY')
  const accessToken = requiredEnv('SUPABASE_ACCESS_TOKEN')

  const fixtures = await loadFixtures(fixturesDir)
  console.log(
    `Loaded ${fixtures.length} fixtures from ${fixturesDir}, running against ${model}...\n`,
  )

  const results: CaseResult[] = []
  for (const fixture of fixtures) {
    const actual = await runFixture(fixture, { baseUrl, publishableKey, accessToken, model })

    if (STATE_DEPENDENT_BEHAVIORS.has(fixture.expectedBehavior)) {
      results.push({
        fixture,
        verdict: 'skipped',
        reason:
          'state-dependent fixture -- no deterministic seed/eval account in this Epic (see README)',
        ...actual,
      })
      continue
    }

    const graded = gradeCase(fixture, actual)
    results.push({ fixture, verdict: graded.verdict, reason: graded.reason, ...actual })
  }

  const summary = { pass: 0, fail: 0, skipped: 0, manualReview: 0 }
  for (const r of results) {
    if (r.verdict === 'pass') summary.pass++
    else if (r.verdict === 'fail') summary.fail++
    else if (r.verdict === 'skipped') summary.skipped++
    else summary.manualReview++
  }

  console.log('── Results ──\n')
  for (const r of results) {
    console.log(`[${r.verdict.toUpperCase()}] ${r.fixture.id} (${r.fixture.category}): ${r.reason}`)
    if (r.verdict === 'manual-review' || r.verdict === 'skipped') {
      console.log(`  assistantText: ${JSON.stringify(r.assistantText)}`)
    }
  }

  console.log('\n── Summary ──')
  console.log(
    `pass: ${summary.pass}  fail: ${summary.fail}  skipped: ${summary.skipped}  manual-review: ${summary.manualReview}  (of ${fixtures.length})`,
  )

  if (args.json) {
    const output = {
      run: {
        model,
        executedAt: new Date().toISOString(),
        corpus: 'agent-v0',
        fixtureCount: fixtures.length,
      },
      summary,
      cases: results,
    }
    await Deno.writeTextFile(args.json, JSON.stringify(output, null, 2))
    console.log(`\nWrote full results to ${args.json}`)
  }
}

if (import.meta.main) {
  await main()
}
