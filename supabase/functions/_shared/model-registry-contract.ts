export type LatencyClass = 'fast' | 'medium' | 'slow'
export type CostClass = 'low' | 'medium' | 'high'

export type ModelProfile = {
  id: string
  supportsTools: boolean
  // null = no eval:compare data has been promoted into the registry for
  // this model yet -- not "unknown/bad", just "never measured".
  latencyClass: LatencyClass | null
  costClass: CostClass | null
  // pass / (pass+fail) from the last promoted eval:compare run -- scored
  // over automatically-graded cases only. manualReview fixtures (inherently
  // un-gradable from outside, per Epic E) are excluded from the
  // denominator entirely, so this is NOT "% of the full corpus passed";
  // a model can legitimately show a high evalScore while a large share of
  // the corpus was manual-review and never counted either way.
  evalScore: number | null
  enabled: boolean
}

// Seeded 1:1 with today's ALLOWED_OPENROUTER_MODELS, all enabled, all
// eval fields null -- this commit changes zero user-facing behavior.
// latencyClass/costClass/evalScore get filled in later by actually running
// `npm run eval:compare` for real and pasting the promoted values in via a
// follow-up, reviewed PR (see eval/promote-registry.ts).
export const MODEL_REGISTRY: ModelProfile[] = [
  {
    id: 'openai/gpt-5.4-mini',
    supportsTools: true,
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'openai/gpt-5.6-sol',
    supportsTools: true,
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'anthropic/claude-sonnet-5',
    supportsTools: true,
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'google/gemini-3.5-flash',
    supportsTools: true,
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'qwen/qwen3.7-flash',
    supportsTools: true,
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
]

// A duplicate id would silently corrupt every downstream consumer:
// selectableModelIds() would list it twice, and agent-models-contract.ts's
// `Map(... .map(m => [m.id, m]))` construction would let the later entry
// silently overwrite the earlier one with no error. Fail fast at module
// load instead of letting that surface as confusing behavior somewhere
// else entirely.
const registryIds = MODEL_REGISTRY.map((m) => m.id)
if (new Set(registryIds).size !== registryIds.length) {
  throw new Error('MODEL_REGISTRY has duplicate model ids')
}

// Registry-side eligibility only: a model must be both enabled and declared
// tool-capable for Memdo to allow it at all.
//
// This does NOT replace OpenRouter live validation. A selectable registry
// model may still be omitted from the live catalog (agent-models-contract.ts)
// if OpenRouter currently reports that it lacks tools/text support, valid
// pricing, etc. These are two independent gates, not one policy duplicated
// in two places -- "do we allow this model" (here) and "is it actually
// usable right now" (OpenRouter's live /models response) can disagree, and
// when they do, the live check is what determines the final catalog.
export function selectableModelIds(registry: ModelProfile[] = MODEL_REGISTRY): string[] {
  return registry.filter((m) => m.enabled && m.supportsTools).map((m) => m.id)
}

// Fixed absolute thresholds (not relative to other models) so a model's
// class doesn't silently shift just because a different model got faster/
// cheaper. Thresholds are a starting judgment call, not derived from any
// spec -- adjust freely in review.
export function classifyLatencyMs(avgFixtureWallMs: number): LatencyClass {
  if (!Number.isFinite(avgFixtureWallMs) || avgFixtureWallMs < 0) {
    throw new Error('avgFixtureWallMs must be a non-negative finite number')
  }
  if (avgFixtureWallMs < 2000) return 'fast'
  if (avgFixtureWallMs < 5000) return 'medium'
  return 'slow'
}

// Guards its own contract rather than trusting the caller -- promote-
// registry.ts's normal flow only calls this for a complete run (never 0
// requests), but the pure helper shouldn't silently turn a caller bug
// (requestCount=0, division by zero producing Infinity) into a bogus
// 'high' classification.
export function classifyCostPerRequest(costUsd: number, requestCount: number): CostClass {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error('costUsd must be a non-negative finite number')
  }
  if (!Number.isInteger(requestCount) || requestCount <= 0) {
    throw new Error('requestCount must be a positive integer')
  }
  const perRequest = costUsd / requestCount
  if (perRequest < 0.003) return 'low'
  if (perRequest < 0.02) return 'medium'
  return 'high'
}
