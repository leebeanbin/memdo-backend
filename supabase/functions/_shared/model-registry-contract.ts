export type LatencyClass = 'fast' | 'medium' | 'slow'
export type CostClass = 'low' | 'medium' | 'high'

// - 'recommended': fixed curated model ids that either have passed Memdo
//   eval or are the paid baseline candidates for it. Default picker choice
//   lives here (see AssistantView.swift's CloudAgentModelPreference).
// - 'free-auto': OpenRouter's `openrouter/free` Free Models Router only.
//   Zero-cost and useful for founder dogfooding/availability resilience,
//   but NOT model-deterministic -- separate requests can resolve to
//   different underlying free models. Must never be promoted with a real
//   evalScore (computeModelProfiles in eval/promote-registry.ts refuses
//   this by tier) and must be excluded from eval:compare's default
//   reproducible run set (see reproducibleModelIds below) -- a score
//   measured against one request's resolved model would misrepresent the
//   router itself as having been evaluated.
// - 'validated-free': fixed (non-router) `:free` model ids that have
//   individually gone through the same eval:compare -> promote-registry
//   pipeline as a 'recommended' model and earned a real evalScore. Never
//   set by promotion automatically -- like `enabled`/`supportsTools`,
//   moving a model from 'experimental' to 'validated-free' is a deliberate,
//   reviewed code edit after eyeballing a promoted run, not something a
//   script infers from a threshold.
// - 'experimental': selectable for developer testing only, not promoted to
//   users as free-tier-validated. iOS gates these behind a developer-only
//   surface (see CloudAgentSettings.swift) rather than showing them in the
//   normal picker -- "selectable for developer testing" is not the same as
//   "recommended to every user."
export type ModelTier = 'recommended' | 'free-auto' | 'validated-free' | 'experimental'

export type ModelProfile = {
  id: string
  supportsTools: boolean
  tier: ModelTier
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
  //
  // Always null for tier 'free-auto' -- see the ModelTier doc comment.
  evalScore: number | null
  enabled: boolean
}

// The original 5 curated paid models, all enabled, all eval fields null --
// unchanged by D3. latencyClass/costClass/evalScore get filled in later by
// actually running `npm run eval:compare` for real and pasting the promoted
// values in via a follow-up, reviewed PR (see eval/promote-registry.ts).
//
// D3 adds two more kinds of entry below: 'free-auto' (OpenRouter's
// openrouter/free router, exactly one entry, permanently unpromotable) and
// 'experimental' (fixed :free model ids identified as tool-capable via a
// live OpenRouter catalog query on 2026-08-27 -- selectable for developer
// testing, not yet run through eval:compare, so not yet 'validated-free').
export const MODEL_REGISTRY: ModelProfile[] = [
  {
    id: 'openai/gpt-5.4-mini',
    supportsTools: true,
    tier: 'recommended',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'openai/gpt-5.6-sol',
    supportsTools: true,
    tier: 'recommended',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'anthropic/claude-sonnet-5',
    supportsTools: true,
    tier: 'recommended',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'google/gemini-3.5-flash',
    supportsTools: true,
    tier: 'recommended',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'qwen/qwen3.7-flash',
    supportsTools: true,
    tier: 'recommended',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'openrouter/free',
    supportsTools: true,
    tier: 'free-auto',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    supportsTools: true,
    tier: 'experimental',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    supportsTools: true,
    tier: 'experimental',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'z-ai/glm-5.2:free',
    supportsTools: true,
    tier: 'experimental',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
  },
  {
    id: 'minimax/minimax-m3:free',
    supportsTools: true,
    tier: 'experimental',
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

// Same eligibility as selectableModelIds, minus tier 'free-auto' -- used as
// eval/compare.ts's default multi-model comparison set so a routine
// "compare everything" run doesn't waste requests measuring a
// non-deterministic router as if it were one fixed model. A 'free-auto'
// model can still be compared explicitly via --models for ad-hoc curiosity;
// this only changes what runs by default. computeModelProfiles
// (eval/promote-registry.ts) enforces the same exclusion independently at
// the promotion boundary, so this isn't the only guard against a
// 'free-auto' entry acquiring a real evalScore -- it's the one that saves
// the wasted requests in the first place.
export function reproducibleModelIds(registry: ModelProfile[] = MODEL_REGISTRY): string[] {
  return selectableModelIds(registry.filter((m) => m.tier !== 'free-auto'))
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
