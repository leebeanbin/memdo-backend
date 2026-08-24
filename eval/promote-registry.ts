// Turns a real `eval:compare --json` run into ready-to-paste MODEL_REGISTRY
// entries. Deliberately prints, never writes source files -- promoting a
// model into the shipped registry is a reviewed code change, not something
// a script should commit unattended (same reasoning as F-1/F-2's "no
// silent state mutation").
//
// Only reads a local file and writes to stdout/stderr -- no network, no
// env vars, no filesystem writes.
//
// Usage:
//   deno run --allow-read eval/promote-registry.ts <path-to-eval-compare-report.json>
//
// or: npm run eval:promote-registry -- <path-to-eval-compare-report.json>

import { z } from 'zod'
import type { ModelComparison } from './compare.ts'
import {
  classifyCostPerRequest,
  classifyLatencyMs,
  MODEL_REGISTRY,
  type ModelProfile,
} from '../supabase/functions/_shared/model-registry-contract.ts'

export type PromotionWarning = {
  model: string
  reason: 'unknown-model' | 'incomplete-run' | 'no-graded-cases'
  message: string
}

export type PromotionResult = {
  profiles: ModelProfile[]
  warnings: PromotionWarning[]
}

// Pure: no console.error, no I/O. Skipped/unknown models are reported via
// the returned `warnings` array instead of a side effect, so the CLI (the
// only caller that should ever touch stderr) decides what to do with them
// -- this function's output depends only on its inputs, which is what
// makes it testable without capturing console output.
export function computeModelProfiles(
  comparisons: ModelComparison[],
  previous: ModelProfile[],
): PromotionResult {
  const byId = new Map(previous.map((p) => [p.id, p]))
  const warnings: PromotionWarning[] = []

  for (const c of comparisons) {
    const prior = byId.get(c.model)
    if (!prior) {
      // never silently add an unknown model to the registry
      warnings.push({
        model: c.model,
        reason: 'unknown-model',
        message: `${c.model}: not present in MODEL_REGISTRY -- ignored.`,
      })
      continue
    }

    // Fail-closed on anything short of a full, uninterrupted corpus run.
    // A rate-limited stop is NOT "a slightly smaller sample" -- eval:compare
    // stops immediately at the point of the 429, so completedCount reflects
    // a fixed PREFIX of the corpus (whatever category ordering agent-v0's
    // files happen to have), not a random subset. Computing evalScore from
    // "first 12/38 fixtures, all pass" and promoting that as the model's
    // real score would silently launder a biased sample into a trusted
    // number -- exactly the kind of incomplete-data-treated-as-complete
    // mistake F-2's own rateLimited/completedCount reporting exists to
    // surface, not paper over. So: only a run where nothing was skipped at
    // all gets promoted; anything else keeps the model's previous registry
    // values untouched and is reported as a warning for the human to go
    // re-run, not silently dropped.
    const complete = !c.rateLimited && c.completedCount === c.fixtureCount
    if (!complete) {
      warnings.push({
        model: c.model,
        reason: 'incomplete-run',
        message: `${c.model}: incomplete run (${c.completedCount}/${c.fixtureCount}` +
          `${
            c.rateLimited ? ', rate-limited' : ''
          }) -- not promoted, keeping previous registry values.`,
      })
      continue
    }

    // Score over automatically-graded cases only (pass + fail).
    // manualReview fixtures are intentionally excluded from the
    // denominator -- they're inherently un-gradable from outside (Epic
    // E's finding), not a pass or a fail, so folding them in would either
    // penalize or inflate the score based on something that says nothing
    // about model quality. This means evalScore is NOT "% of the full
    // corpus passed" -- a model could score 100% while ~half the corpus
    // (the manual-review cases) was never counted either way.
    const denom = c.pass + c.fail
    if (denom === 0) {
      // Every completed fixture was manual-review -- there's no evalScore
      // signal at all this run. Skip promotion for this model entirely
      // rather than updating latencyClass/costClass alone: doing a partial
      // update would produce a mixed-vintage profile (this run's
      // latency/cost sitting next to a stale evalScore from whenever it
      // was last actually measured), which misrepresents the registry as
      // one coherent snapshot when it isn't.
      warnings.push({
        model: c.model,
        reason: 'no-graded-cases',
        message:
          `${c.model}: run completed but 0 automatically-graded cases (all manual-review) -- not promoted, keeping previous registry values.`,
      })
      continue
    }

    byId.set(c.model, {
      ...prior,
      latencyClass: c.avgFixtureWallMs === null
        ? prior.latencyClass
        : classifyLatencyMs(c.avgFixtureWallMs),
      costClass: classifyCostPerRequest(c.costUsd, c.requestCount),
      evalScore: c.pass / denom,
      // enabled/supportsTools are never touched by promotion -- those are
      // deliberate code edits, not eval-data-driven.
    })
  }

  return { profiles: [...byId.values()], warnings }
}

// Fail-fast on malformed input -- this reads a file a human hand-picked off
// disk, not a value this script produced itself, so it gets the same
// distrust `run.ts`'s fixture loading applies to its own inputs. A Zod
// schema checks every field computeModelProfiles actually reads, not just
// the container shape.
const modelComparisonSchema = z.object({
  model: z.string(),
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  manualReview: z.number().int().nonnegative(),
  fixtureCount: z.number().int().positive(), // 0 fixtures isn't a real corpus run
  completedCount: z.number().int().nonnegative(),
  rateLimited: z.boolean(),
  avgFixtureWallMs: z.number().finite().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative(),
  requestCount: z.number().int().nonnegative(),
}).passthrough() // ModelComparison carries other fields (elapsedMs, tokens, ...) unused here
  // Field-type validation alone lets a hand-edited/corrupted report through
  // (e.g. avgFixtureWallMs: -500, or completedCount that doesn't match
  // pass+fail+manualReview) that computeModelProfiles would then treat as
  // a legitimate complete run. F-2's own eval:compare already enforces
  // these invariants at the source (requestCount === completedCount is
  // exactly the usage-row invariant F-2 added to guarantee cost-data
  // trustworthiness) -- re-checking them here closes the gap between
  // "trusting the file F-2 wrote" and "trusting whatever file someone
  // hands this CLI," which won't always be the same thing.
  .superRefine((c, ctx) => {
    if (c.completedCount > c.fixtureCount) {
      ctx.addIssue({ code: 'custom', message: 'completedCount must not exceed fixtureCount' })
    }
    if (c.pass + c.fail + c.manualReview !== c.completedCount) {
      ctx.addIssue({
        code: 'custom',
        message: 'pass + fail + manualReview must equal completedCount',
      })
    }
    if (c.requestCount !== c.completedCount) {
      ctx.addIssue({ code: 'custom', message: 'requestCount must equal completedCount' })
    }
    if (c.completedCount === 0 && c.avgFixtureWallMs !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'avgFixtureWallMs must be null when no fixtures completed',
      })
    }
    if (c.completedCount > 0 && c.avgFixtureWallMs === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'avgFixtureWallMs is required when fixtures completed',
      })
    }
  })

// A real eval:compare run never produces two entries for the same model,
// but this file is untrusted input -- if it did, computeModelProfiles'
// last-write-wins Map.set would silently let the second one win with no
// signal that anything was wrong. Reject it as malformed instead.
const comparisonsFileSchema = z.object({
  comparisons: z.array(modelComparisonSchema),
}).superRefine(({ comparisons }, ctx) => {
  const seen = new Set<string>()
  for (const c of comparisons) {
    if (seen.has(c.model)) {
      ctx.addIssue({ code: 'custom', message: `duplicate model comparison: ${c.model}` })
    }
    seen.add(c.model)
  }
})

export function parseComparisonsFile(raw: unknown): ModelComparison[] {
  const parsed = comparisonsFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`invalid eval:compare --json file: ${parsed.error.message}`)
  }
  return parsed.data.comparisons as ModelComparison[]
}

function formatRegistry(profiles: ModelProfile[]): string {
  const lines = profiles.map((p) => {
    const fields = [
      `id: ${JSON.stringify(p.id)}`,
      `supportsTools: ${p.supportsTools}`,
      `latencyClass: ${p.latencyClass === null ? 'null' : JSON.stringify(p.latencyClass)}`,
      `costClass: ${p.costClass === null ? 'null' : JSON.stringify(p.costClass)}`,
      `evalScore: ${p.evalScore === null ? 'null' : p.evalScore}`,
      `enabled: ${p.enabled}`,
    ]
    return `  { ${fields.join(', ')} },`
  })
  return `export const MODEL_REGISTRY: ModelProfile[] = [\n${lines.join('\n')}\n]`
}

async function main() {
  const path = Deno.args[0]
  if (!path) {
    console.error('Usage: eval/promote-registry.ts <path-to-eval-compare-report.json>')
    Deno.exit(1)
  }

  let raw: unknown
  try {
    raw = JSON.parse(await Deno.readTextFile(path))
  } catch (error) {
    console.error(`Could not read/parse ${path}: ${error}`)
    Deno.exit(1)
  }

  let comparisons: ModelComparison[]
  try {
    comparisons = parseComparisonsFile(raw)
  } catch (error) {
    console.error(String(error))
    Deno.exit(1)
  }

  const result = computeModelProfiles(comparisons, MODEL_REGISTRY)
  for (const warning of result.warnings) console.error(warning.message)
  console.log(formatRegistry(result.profiles))
}

if (import.meta.main) {
  await main()
}
