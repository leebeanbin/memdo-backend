import type { ModelComparison } from './compare.ts'
import { computeModelProfiles, parseComparisonsFile } from './promote-registry.ts'
import type { ModelProfile } from '../supabase/functions/_shared/model-registry-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

function profile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'model-a',
    supportsTools: true,
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
    ...overrides,
  }
}

function comparison(overrides: Partial<ModelComparison>): ModelComparison {
  return {
    model: 'model-a',
    pass: 30,
    fail: 8,
    manualReview: 0,
    fixtureCount: 38,
    completedCount: 38,
    rateLimited: false,
    elapsedMs: 12_000,
    avgFixtureWallMs: 1500,
    costUsd: 0.5,
    promptTokens: 10_000,
    completionTokens: 2_000,
    requestCount: 38,
    ...overrides,
  }
}

Deno.test('computeModelProfiles is pure -- no I/O, output depends only on inputs', () => {
  const previous = [profile({})]
  const result1 = computeModelProfiles([comparison({})], previous)
  const result2 = computeModelProfiles([comparison({})], previous)
  assert(JSON.stringify(result1) === JSON.stringify(result2))
})

Deno.test('computeModelProfiles: a complete run updates latencyClass/costClass/evalScore', () => {
  const previous = [profile({})]
  const result = computeModelProfiles([comparison({})], previous)
  assert(result.warnings.length === 0)
  assert(result.profiles.length === 1)
  assert(result.profiles[0].latencyClass === 'fast') // 1500ms < 2000 -> fast
  assert(result.profiles[0].costClass !== null)
  assert(result.profiles[0].evalScore === 30 / 38)
})

Deno.test('computeModelProfiles: unknown model is ignored and reported, not auto-added', () => {
  const result = computeModelProfiles([comparison({ model: 'not-in-registry' })], [profile({})])
  assert(result.profiles.length === 1) // unchanged, still just model-a
  assert(result.warnings.length === 1)
  assert(result.warnings[0].reason === 'unknown-model')
  assert(result.warnings[0].model === 'not-in-registry')
})

Deno.test('computeModelProfiles: rate-limited run keeps previous values and warns, never promotes a prefix sample', () => {
  const previous = [profile({ latencyClass: 'slow', costClass: 'high', evalScore: 0.5 })]
  const result = computeModelProfiles(
    [comparison({
      rateLimited: true,
      completedCount: 12,
      fixtureCount: 38,
      pass: 12,
      fail: 0,
      requestCount: 12,
    })],
    previous,
  )
  assert(result.warnings.length === 1)
  assert(result.warnings[0].reason === 'incomplete-run')
  assert(result.profiles[0].latencyClass === 'slow')
  assert(result.profiles[0].costClass === 'high')
  assert(result.profiles[0].evalScore === 0.5)
})

Deno.test('computeModelProfiles: completedCount !== fixtureCount without rateLimited is still incomplete', () => {
  const previous = [profile({ evalScore: 0.5 })]
  const result = computeModelProfiles(
    [comparison({ rateLimited: false, completedCount: 20, fixtureCount: 38, requestCount: 20 })],
    previous,
  )
  assert(result.warnings[0].reason === 'incomplete-run')
  assert(result.profiles[0].evalScore === 0.5)
})

Deno.test('computeModelProfiles: complete run with pass+fail=0 is not partially promoted', () => {
  const previous = [profile({ latencyClass: 'slow', costClass: 'high', evalScore: 0.7 })]
  const result = computeModelProfiles(
    [comparison({ pass: 0, fail: 0, manualReview: 38, completedCount: 38, requestCount: 38 })],
    previous,
  )
  assert(result.warnings.length === 1)
  assert(result.warnings[0].reason === 'no-graded-cases')
  // latencyClass/costClass are NOT updated either, even though
  // avgFixtureWallMs/costUsd were present -- no mixed-vintage profile.
  assert(result.profiles[0].latencyClass === 'slow')
  assert(result.profiles[0].costClass === 'high')
  assert(result.profiles[0].evalScore === 0.7)
})

Deno.test('computeModelProfiles: enabled/supportsTools are never modified by promotion', () => {
  const previous = [profile({ enabled: false, supportsTools: true })]
  const result = computeModelProfiles([comparison({})], previous)
  assert(result.profiles[0].enabled === false)
  assert(result.profiles[0].supportsTools === true)
})

Deno.test('parseComparisonsFile accepts a valid { comparisons } file', () => {
  const parsed = parseComparisonsFile({ comparisons: [comparison({})] })
  assert(parsed.length === 1)
  assert(parsed[0].model === 'model-a')
})

Deno.test('parseComparisonsFile rejects a non-object / missing comparisons', () => {
  for (const bad of [null, undefined, 'hello', 123, [], {}]) {
    let threw = false
    try {
      parseComparisonsFile(bad)
    } catch {
      threw = true
    }
    assert(threw)
  }
})

Deno.test('parseComparisonsFile rejects per-entry type errors', () => {
  let threw = false
  try {
    parseComparisonsFile({ comparisons: [{ model: 123 }, null, 'hello'] })
  } catch {
    threw = true
  }
  assert(threw)
})

Deno.test('parseComparisonsFile enforces cross-field invariants', () => {
  const cases: Partial<ModelComparison>[] = [
    { completedCount: 40, fixtureCount: 38 }, // completedCount > fixtureCount
    { pass: 30, fail: 8, manualReview: 1, completedCount: 38 }, // sum !== completedCount
    { requestCount: 37, completedCount: 38 }, // requestCount !== completedCount
    {
      completedCount: 0,
      avgFixtureWallMs: 100,
      pass: 0,
      fail: 0,
      manualReview: 0,
      requestCount: 0,
    }, // avgFixtureWallMs must be null
    { completedCount: 38, avgFixtureWallMs: null }, // avgFixtureWallMs required when completed>0
    { avgFixtureWallMs: -500 }, // negative
    {
      fixtureCount: 0,
      completedCount: 0,
      pass: 0,
      fail: 0,
      manualReview: 0,
      requestCount: 0,
      avgFixtureWallMs: null,
    }, // fixtureCount must be positive
  ]
  for (const overrides of cases) {
    let threw = false
    try {
      parseComparisonsFile({ comparisons: [comparison(overrides)] })
    } catch {
      threw = true
    }
    assert(threw)
  }
})

Deno.test('parseComparisonsFile rejects duplicate model entries', () => {
  let threw = false
  try {
    parseComparisonsFile({ comparisons: [comparison({}), comparison({})] })
  } catch {
    threw = true
  }
  assert(threw)
})
