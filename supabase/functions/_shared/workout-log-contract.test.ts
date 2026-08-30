import { workoutLogCreateSchema, workoutLogUpdateDetailsSchema } from './workout-log-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

function validCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    source: 'healthkit',
    activityType: 'running',
    startedAt: '2026-08-30T06:00:00Z',
    endedAt: '2026-08-30T06:30:00Z',
    durationSec: 1800,
    scheduledDate: '2026-08-30',
    ...overrides,
  }
}

Deno.test('workoutLogCreateSchema accepts a real HealthKit sync payload', () => {
  const result = workoutLogCreateSchema.safeParse(validCreateInput())
  assert(result.success)
})

Deno.test('workoutLogCreateSchema accepts durationSec: 0 -- a real value, not a missing one (be10)', () => {
  // The bug this schema replaces: a truthy-check (`if (!durationSec)`)
  // rejected a genuine zero-duration sample.
  const result = workoutLogCreateSchema.safeParse(validCreateInput({ durationSec: 0 }))
  assert(result.success)
})

Deno.test('workoutLogCreateSchema rejects a non-numeric durationSec instead of reaching Postgres (be10)', () => {
  const result = workoutLogCreateSchema.safeParse(validCreateInput({ durationSec: 'abc' }))
  assert(!result.success)
})

Deno.test('workoutLogCreateSchema rejects an unknown activityType', () => {
  const result = workoutLogCreateSchema.safeParse(
    validCreateInput({ activityType: 'skateboarding' }),
  )
  assert(!result.success)
})

Deno.test('workoutLogCreateSchema rejects an unknown source', () => {
  const result = workoutLogCreateSchema.safeParse(validCreateInput({ source: 'strava' }))
  assert(!result.success)
})

Deno.test('workoutLogCreateSchema defaults source to manual when omitted', () => {
  const input = validCreateInput()
  // deno-lint-ignore no-explicit-any
  delete (input as any).source
  const result = workoutLogCreateSchema.safeParse(input)
  assert(result.success)
  if (result.success) assert(result.data.source === 'manual')
})

Deno.test('workoutLogCreateSchema rejects endedAt before startedAt', () => {
  const result = workoutLogCreateSchema.safeParse(
    validCreateInput({ startedAt: '2026-08-30T06:30:00Z', endedAt: '2026-08-30T06:00:00Z' }),
  )
  assert(!result.success)
})

Deno.test('workoutLogCreateSchema rejects an exercises array past the size cap', () => {
  const exercises = Array.from({ length: 201 }, (_, i) => ({
    id: `ex-${i}`,
    name: '스쿼트',
    sets: 3,
  }))
  const result = workoutLogCreateSchema.safeParse(validCreateInput({ exercises }))
  assert(!result.success)
})

Deno.test('workoutLogCreateSchema accepts a well-formed exercises array', () => {
  const result = workoutLogCreateSchema.safeParse(validCreateInput({
    exercises: [
      { id: 'ex-1', name: '벤치프레스', sets: 4, reps: 8, weightKg: 60, durationSeconds: null },
    ],
  }))
  assert(result.success)
})

Deno.test('workoutLogUpdateDetailsSchema accepts an empty body, defaulting notes', () => {
  const result = workoutLogUpdateDetailsSchema.safeParse({})
  assert(result.success)
  if (result.success) assert(result.data.notes === '')
})

Deno.test('workoutLogUpdateDetailsSchema rejects an exercises array past the size cap', () => {
  const exercises = Array.from({ length: 201 }, (_, i) => ({
    id: `ex-${i}`,
    name: '스쿼트',
    sets: 3,
  }))
  const result = workoutLogUpdateDetailsSchema.safeParse({ exercises })
  assert(!result.success)
})
