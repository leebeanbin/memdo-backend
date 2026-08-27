import {
  classifyCostPerRequest,
  classifyLatencyMs,
  MODEL_REGISTRY,
  type ModelProfile,
  reproducibleModelIds,
  selectableModelIds,
} from './model-registry-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

function profile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'test/model',
    supportsTools: true,
    tier: 'recommended',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
    ...overrides,
  }
}

Deno.test('MODEL_REGISTRY has no duplicate ids', () => {
  const ids = MODEL_REGISTRY.map((m) => m.id)
  assert(new Set(ids).size === ids.length)
})

Deno.test('selectableModelIds requires both enabled and supportsTools', () => {
  const registry: ModelProfile[] = [
    profile({ id: 'enabled-tools', enabled: true, supportsTools: true }),
    profile({ id: 'disabled-tools', enabled: false, supportsTools: true }),
    profile({ id: 'enabled-no-tools', enabled: true, supportsTools: false }),
    profile({ id: 'disabled-no-tools', enabled: false, supportsTools: false }),
  ]
  assert(selectableModelIds(registry).length === 1)
  assert(selectableModelIds(registry)[0] === 'enabled-tools')
})

Deno.test('selectableModelIds on the real MODEL_REGISTRY returns every seeded id', () => {
  const ids = selectableModelIds(MODEL_REGISTRY)
  assert(ids.length === MODEL_REGISTRY.length)
  for (const m of MODEL_REGISTRY) assert(ids.includes(m.id))
})

Deno.test('MODEL_REGISTRY has exactly one free-auto entry: openrouter/free', () => {
  const freeAuto = MODEL_REGISTRY.filter((m) => m.tier === 'free-auto')
  assert(freeAuto.length === 1)
  assert(freeAuto[0].id === 'openrouter/free')
  assert(freeAuto[0].evalScore === null)
})

Deno.test('reproducibleModelIds excludes tier free-auto but keeps every other selectable id', () => {
  const registry: ModelProfile[] = [
    profile({ id: 'recommended-model', tier: 'recommended' }),
    profile({ id: 'free-auto-model', tier: 'free-auto' }),
    profile({ id: 'validated-free-model', tier: 'validated-free' }),
    profile({ id: 'experimental-model', tier: 'experimental' }),
  ]
  const ids = reproducibleModelIds(registry)
  assert(ids.length === 3)
  assert(!ids.includes('free-auto-model'))
  assert(ids.includes('recommended-model'))
  assert(ids.includes('validated-free-model'))
  assert(ids.includes('experimental-model'))
})

Deno.test('reproducibleModelIds on the real MODEL_REGISTRY excludes openrouter/free only', () => {
  const ids = reproducibleModelIds(MODEL_REGISTRY)
  assert(!ids.includes('openrouter/free'))
  assert(ids.length === selectableModelIds(MODEL_REGISTRY).length - 1)
})

Deno.test('classifyLatencyMs boundary cases', () => {
  assert(classifyLatencyMs(0) === 'fast')
  assert(classifyLatencyMs(1999) === 'fast')
  assert(classifyLatencyMs(2000) === 'medium')
  assert(classifyLatencyMs(4999) === 'medium')
  assert(classifyLatencyMs(5000) === 'slow')
  assert(classifyLatencyMs(10_000) === 'slow')
})

Deno.test('classifyLatencyMs rejects invalid input', () => {
  let threw = false
  try {
    classifyLatencyMs(-1)
  } catch {
    threw = true
  }
  assert(threw)

  threw = false
  try {
    classifyLatencyMs(NaN)
  } catch {
    threw = true
  }
  assert(threw)

  threw = false
  try {
    classifyLatencyMs(Infinity)
  } catch {
    threw = true
  }
  assert(threw)
})

Deno.test('classifyCostPerRequest boundary cases', () => {
  assert(classifyCostPerRequest(0, 1) === 'low')
  assert(classifyCostPerRequest(0.00299, 1) === 'low')
  assert(classifyCostPerRequest(0.003, 1) === 'medium')
  assert(classifyCostPerRequest(0.01999, 1) === 'medium')
  assert(classifyCostPerRequest(0.02, 1) === 'high')
  assert(classifyCostPerRequest(1, 1) === 'high')
  // per-request math, not just totals
  assert(classifyCostPerRequest(0.04, 20) === 'low') // 0.002/request
})

Deno.test('classifyCostPerRequest rejects invalid input', () => {
  let threw = false
  try {
    classifyCostPerRequest(-1, 1)
  } catch {
    threw = true
  }
  assert(threw)

  threw = false
  try {
    classifyCostPerRequest(NaN, 1)
  } catch {
    threw = true
  }
  assert(threw)

  threw = false
  try {
    classifyCostPerRequest(1, 0)
  } catch {
    threw = true
  }
  assert(threw)

  threw = false
  try {
    classifyCostPerRequest(1, 1.5)
  } catch {
    threw = true
  }
  assert(threw)

  threw = false
  try {
    classifyCostPerRequest(1, -1)
  } catch {
    threw = true
  }
  assert(threw)
})
