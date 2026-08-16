import {
  accumulatedToolCallsArray,
  applyStreamChunk,
  expandScope,
  findConflict,
  newStreamAccumulator,
  parseStreamLine,
  resolveDate,
  resolveProposedInterval,
  timeOn,
} from './agent-cloud-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

// Existing-row timestamps go through timeOn() too (same as production
// values, which are real TIMESTAMPTZ instants) rather than bare
// "YYYY-MM-DDTHH:mm:ss" strings -- those have no offset, so `new Date(...)`
// parses them against the *host process's* timezone, which is exactly the
// ambiguity this whole file's source functions were rewritten to avoid.
function localAt(hhmm: string): string {
  return timeOn('2026-08-16', hhmm)!.toISOString()
}

// Fixed reference point so date-relative tests don't depend on when they run.
const today = new Date('2026-08-16T00:00:00Z')

Deno.test('resolveDate handles today/tomorrow/explicit', () => {
  assert(resolveDate('today', today) === '2026-08-16')
  assert(resolveDate('tomorrow', today) === '2026-08-17')
  assert(resolveDate('2026-09-01', today) === '2026-09-01')
})

Deno.test('expandScope this_week is 7 consecutive days starting today', () => {
  const dates = expandScope('this_week', today)
  assert(dates.length === 7)
  assert(dates[0] === '2026-08-16')
  assert(dates[6] === '2026-08-22')
})

Deno.test('expandScope passes an explicit date through unchanged', () => {
  assert(JSON.stringify(expandScope('2026-09-01', today)) === JSON.stringify(['2026-09-01']))
})

Deno.test('resolveProposedInterval is null for a task', () => {
  const interval = resolveProposedInterval(
    { title: '빨래', date: 'today', isTask: true },
    today,
  )
  assert(interval === null)
})

Deno.test('resolveProposedInterval defaults a missing end time to +1 hour', () => {
  const interval = resolveProposedInterval(
    { title: '회의', date: 'today', startTime: '14:00', isTask: false },
    today,
  )
  assert(interval !== null)
  assert(interval!.end.getTime() - interval!.start.getTime() === 3_600_000)
})

Deno.test('findConflict detects an overlapping existing event', () => {
  const conflict = findConflict(
    [
      {
        title: '팀 회의',
        scheduled_date: '2026-08-16',
        start_at: localAt('14:00'),
        end_at: localAt('15:00'),
      },
    ],
    { title: '점심 약속', date: 'today', startTime: '14:30', endTime: '15:30', isTask: false },
    today,
  )
  assert(conflict === '팀 회의')
})

Deno.test('findConflict returns null when nothing overlaps', () => {
  const conflict = findConflict(
    [
      {
        title: '팀 회의',
        scheduled_date: '2026-08-16',
        start_at: localAt('09:00'),
        end_at: localAt('10:00'),
      },
    ],
    { title: '점심 약속', date: 'today', startTime: '14:00', endTime: '15:00', isTask: false },
    today,
  )
  assert(conflict === null)
})

Deno.test('findConflict is always null for a task -- nothing to overlap', () => {
  const conflict = findConflict(
    [
      {
        title: '팀 회의',
        scheduled_date: '2026-08-16',
        start_at: localAt('14:00'),
        end_at: localAt('15:00'),
      },
    ],
    { title: '장보기', date: 'today', isTask: true },
    today,
  )
  assert(conflict === null)
})

Deno.test('parseStreamLine ignores [DONE] and non-data lines', () => {
  assert(parseStreamLine('data: [DONE]') === null)
  assert(parseStreamLine('') === null)
  assert(parseStreamLine(': keep-alive') === null)
})

Deno.test('parseStreamLine extracts a content delta', () => {
  const chunk = parseStreamLine(
    'data: {"choices":[{"delta":{"content":"안녕"},"finish_reason":null}]}',
  )
  assert(chunk?.content === '안녕')
  assert(chunk?.toolCalls === undefined)
})

Deno.test('parseStreamLine extracts a tool_call delta', () => {
  const chunk = parseStreamLine(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"propose_schedule","arguments":"{\\"tit"}}]},"finish_reason":null}]}',
  )
  assert(chunk?.toolCalls?.length === 1)
  assert(chunk?.toolCalls?.[0].id === 'call_1')
  assert(chunk?.toolCalls?.[0].name === 'propose_schedule')
  assert(chunk?.toolCalls?.[0].argumentsChunk === '{"tit')
})

Deno.test('applyStreamChunk concatenates content across chunks', () => {
  const acc = newStreamAccumulator()
  applyStreamChunk(acc, { content: '안' })
  applyStreamChunk(acc, { content: '녕' })
  assert(acc.content === '안녕')
})

Deno.test('applyStreamChunk accumulates a tool call split across many deltas', () => {
  const acc = newStreamAccumulator()
  applyStreamChunk(acc, { toolCalls: [{ index: 0, id: 'call_1', name: 'propose_schedule' }] })
  applyStreamChunk(acc, { toolCalls: [{ index: 0, argumentsChunk: '{"title":' }] })
  applyStreamChunk(acc, { toolCalls: [{ index: 0, argumentsChunk: '"점심"}' }] })

  const calls = accumulatedToolCallsArray(acc)
  assert(calls.length === 1)
  assert(calls[0].id === 'call_1')
  assert(calls[0].function.name === 'propose_schedule')
  assert(calls[0].function.arguments === '{"title":"점심"}')
  assert(JSON.parse(calls[0].function.arguments).title === '점심')
})

Deno.test('applyStreamChunk keeps multiple concurrent tool calls separate by index', () => {
  const acc = newStreamAccumulator()
  applyStreamChunk(acc, {
    toolCalls: [
      { index: 0, id: 'call_1', name: 'search_schedules' },
      { index: 1, id: 'call_2', name: 'find_free_slots' },
    ],
  })
  const calls = accumulatedToolCallsArray(acc)
  assert(calls.length === 2)
  assert(calls[0].function.name === 'search_schedules')
  assert(calls[1].function.name === 'find_free_slots')
})
