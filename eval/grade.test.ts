import { type DispatchedTool, gradeCase } from './grade.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

function assertEquals(actual: unknown, expected: unknown) {
  assert(actual === expected)
}

function call(name: string, args: Record<string, unknown> = {}): DispatchedTool {
  return { name, args }
}

// ── PROPOSE_SCHEDULE_UPDATE: search-before-update ordering ──

Deno.test('search_schedules -> propose_schedule_update: pass', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    {
      dispatchedTools: [
        call('search_schedules'),
        call('propose_schedule_update', { action: 'complete' }),
      ],
    },
  )
  assertEquals(result.verdict, 'pass')
})

Deno.test('propose_schedule_update only (no search): fail', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    { dispatchedTools: [call('propose_schedule_update', { action: 'complete' })] },
  )
  assertEquals(result.verdict, 'fail')
})

Deno.test('propose_schedule_update -> search_schedules (order reversed): fail', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    {
      dispatchedTools: [
        call('propose_schedule_update', { action: 'complete' }),
        call('search_schedules'),
      ],
    },
  )
  assertEquals(result.verdict, 'fail')
})

Deno.test('find_free_slots -> search_schedules -> propose_schedule_update: pass (extra tool in between is fine)', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    {
      dispatchedTools: [
        call('find_free_slots'),
        call('search_schedules'),
        call('propose_schedule_update', { action: 'complete' }),
      ],
    },
  )
  assertEquals(result.verdict, 'pass')
})

Deno.test('search_schedules -> propose_schedule_update with mismatched expected.action: fail', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    {
      dispatchedTools: [
        call('search_schedules'),
        call('propose_schedule_update', { action: 'delete' }),
      ],
    },
  )
  assertEquals(result.verdict, 'fail')
})

// ── gradeCase itself never returns 'skipped' -- both of these are fail,
// distinguished only by reason. run.ts is what filters state-dependent
// fixtures out before gradeCase is ever called for them. ──

Deno.test('no tool called at all (search never attempted) for PROPOSE_SCHEDULE_UPDATE: fail', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    { dispatchedTools: [] },
  )
  assertEquals(result.verdict, 'fail')
  assert(result.reason.includes('search_schedules was never called'))
})

Deno.test('search_schedules called but propose_schedule_update never follows: fail (not skipped)', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    { dispatchedTools: [call('search_schedules')] },
  )
  assertEquals(result.verdict, 'fail')
})

// ── Repeated tool-call regression: the first occurrence's incidental
// success/failure must not distort the verdict. ──

Deno.test('search -> update(wrong action) -> update(right action, search precedes both): pass on the second call', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    {
      dispatchedTools: [
        call('search_schedules'),
        call('propose_schedule_update', { action: 'delete' }),
        call('propose_schedule_update', { action: 'complete' }),
      ],
    },
  )
  assertEquals(result.verdict, 'pass')
})

Deno.test('update(right action, no search yet) -> search -> update(right action, search precedes it): pass on the second update call', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    {
      dispatchedTools: [
        call('propose_schedule_update', { action: 'complete' }),
        call('search_schedules'),
        call('propose_schedule_update', { action: 'complete' }),
      ],
    },
  )
  assertEquals(result.verdict, 'pass')
})

Deno.test('neither update call satisfies both args and ordering simultaneously: fail', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE_UPDATE', expected: { action: 'complete' } },
    {
      dispatchedTools: [
        call('propose_schedule_update', { action: 'complete' }), // right args, no search before it
        call('search_schedules'),
        call('propose_schedule_update', { action: 'delete' }), // search before it, wrong args
      ],
    },
  )
  assertEquals(result.verdict, 'fail')
})

// ── Unexpected mutation guard ──

Deno.test('SEARCH_SCHEDULES expected, but propose_schedule also fires: fail', () => {
  const result = gradeCase(
    { expectedBehavior: 'SEARCH_SCHEDULES', expected: {} },
    { dispatchedTools: [call('search_schedules'), call('propose_schedule')] },
  )
  assertEquals(result.verdict, 'fail')
})

Deno.test('FIND_FREE_SLOTS expected, but propose_schedule_update also fires: fail', () => {
  const result = gradeCase(
    { expectedBehavior: 'FIND_FREE_SLOTS', expected: {} },
    {
      dispatchedTools: [
        call('find_free_slots'),
        call('propose_schedule_update', { action: 'complete' }),
      ],
    },
  )
  assertEquals(result.verdict, 'fail')
})

Deno.test('SEARCH_SCHEDULES expected, extra read tool alongside it: pass', () => {
  const result = gradeCase(
    { expectedBehavior: 'SEARCH_SCHEDULES', expected: {} },
    { dispatchedTools: [call('search_schedules'), call('get_day_context')] },
  )
  assertEquals(result.verdict, 'pass')
})

// ── ANSWER/UNSUPPORTED ──

Deno.test('ANSWER expected, no tool called: manual-review', () => {
  const result = gradeCase({ expectedBehavior: 'ANSWER' }, { dispatchedTools: [] })
  assertEquals(result.verdict, 'manual-review')
})

Deno.test('UNSUPPORTED expected, no tool called: manual-review', () => {
  const result = gradeCase({ expectedBehavior: 'UNSUPPORTED' }, { dispatchedTools: [] })
  assertEquals(result.verdict, 'manual-review')
})

Deno.test('ANSWER expected, but a tool fires anyway: fail', () => {
  const result = gradeCase({ expectedBehavior: 'ANSWER' }, {
    dispatchedTools: [call('search_schedules')],
  })
  assertEquals(result.verdict, 'fail')
})

// ── PROPOSE_SCHEDULE (create) sanity ──

Deno.test('PROPOSE_SCHEDULE expected, matching args: pass', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE', expected: { date: 'tomorrow', startTime: '15:00' } },
    {
      dispatchedTools: [
        call('propose_schedule', { date: 'tomorrow', startTime: '15:00', title: '치과' }),
      ],
    },
  )
  assertEquals(result.verdict, 'pass')
})

Deno.test('PROPOSE_SCHEDULE expected, mismatched expected field: fail', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE', expected: { date: 'tomorrow' } },
    { dispatchedTools: [call('propose_schedule', { date: 'today' })] },
  )
  assertEquals(result.verdict, 'fail')
})

Deno.test('PROPOSE_SCHEDULE expected, extra unpinned args always pass', () => {
  const result = gradeCase(
    { expectedBehavior: 'PROPOSE_SCHEDULE', expected: { isTask: true } },
    {
      dispatchedTools: [call('propose_schedule', { isTask: true, note: 'unrelated extra field' })],
    },
  )
  assertEquals(result.verdict, 'pass')
})
