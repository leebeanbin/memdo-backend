import {
  accumulatedToolCallsArray,
  addAgentUsage,
  applyStreamChunk,
  dispatchToolCall,
  type ExistingScheduleRow,
  expandScope,
  findConflict,
  newStreamAccumulator,
  newToolDispatchState,
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
        id: 'a1',
        title: '팀 회의',
        scheduled_date: '2026-08-16',
        start_at: localAt('14:00'),
        end_at: localAt('15:00'),
        version: 1,
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
        id: 'a1',
        title: '팀 회의',
        scheduled_date: '2026-08-16',
        start_at: localAt('09:00'),
        end_at: localAt('10:00'),
        version: 1,
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
        id: 'a1',
        title: '팀 회의',
        scheduled_date: '2026-08-16',
        start_at: localAt('14:00'),
        end_at: localAt('15:00'),
        version: 1,
      },
    ],
    { title: '장보기', date: 'today', isTask: true },
    today,
  )
  assert(conflict === null)
})

Deno.test('findConflict excludes the item being updated from its own conflict check', () => {
  const conflict = findConflict(
    [
      {
        id: 'self',
        title: '팀 회의',
        scheduled_date: '2026-08-16',
        start_at: localAt('14:00'),
        end_at: localAt('15:00'),
        version: 1,
      },
    ].filter((row) => row.id !== 'self'),
    { title: '팀 회의', date: 'today', startTime: '14:00', endTime: '15:00', isTask: false },
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

Deno.test('parseStreamLine extracts usage from the final chunk without a delta', () => {
  const chunk = parseStreamLine(
    'data: {"choices":[],"usage":{"prompt_tokens":194,"completion_tokens":2,"total_tokens":196,"cost":0.00095}}',
  )
  assert(chunk?.usage?.promptTokens === 194)
  assert(chunk?.usage?.completionTokens === 2)
  assert(chunk?.usage?.costUsd === 0.00095)
})

Deno.test('applyStreamChunk concatenates content across chunks', () => {
  const acc = newStreamAccumulator()
  applyStreamChunk(acc, { content: '안' })
  applyStreamChunk(acc, { content: '녕' })
  assert(acc.content === '안녕')
})

Deno.test('addAgentUsage totals every tool-loop request', () => {
  const total = newStreamAccumulator().usage
  addAgentUsage(total, { promptTokens: 10, completionTokens: 2, costUsd: 0.001 })
  addAgentUsage(total, { promptTokens: 20, completionTokens: 3, costUsd: 0.002 })
  assert(total.promptTokens === 30)
  assert(total.completionTokens === 5)
  assert(total.costUsd === 0.003)
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

// ── dispatchToolCall: fake Supabase port covering the exact chain shapes
// fetchSchedules()/fetchScheduleById() call (…select().is().gte().lte()
// .limit() awaited directly; …eq().is().maybeSingle() awaited separately).
// Doesn't filter by date range itself -- these tests only ever seed rows on
// the target day, matching how the real DB query would've already narrowed
// them. ──

function fakeSupabase(rows: ExistingScheduleRow[]): { from: (table: string) => any } {
  return {
    from: (_table: string) => {
      let idFilter: string | undefined
      const chain: any = {
        select: () => chain,
        is: () => chain,
        gte: () => chain,
        lte: () => chain,
        limit: () => chain,
        eq: (_col: string, value: string) => {
          idFilter = value
          return chain
        },
        maybeSingle: () =>
          Promise.resolve({ data: rows.find((r) => r.id === idFilter) ?? null, error: null }),
        then: (resolve: (v: { data: ExistingScheduleRow[]; error: null }) => void) =>
          resolve({ data: rows, error: null }),
      }
      return chain
    },
  }
}

function fakeSupabaseError(): { from: (table: string) => any } {
  return {
    from: (_table: string) => {
      const chain: any = {
        select: () => chain,
        is: () => chain,
        gte: () => chain,
        lte: () => chain,
        limit: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: new Error('boom') }),
        then: (resolve: (v: { data: null; error: Error }) => void) =>
          resolve({ data: null, error: new Error('boom') }),
      }
      return chain
    },
  }
}

const dispatchToday = new Date('2026-08-16T00:00:00Z')

Deno.test('dispatchToolCall propose_schedule with no conflict', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeSupabase([]),
    'propose_schedule',
    { title: '점심', date: 'today', startTime: '12:00', endTime: '13:00', isTask: false },
    state,
    dispatchToday,
  )
  assert(result.ok === true)
  assert(result.warning === undefined)
  assert(state.proposedSchedule?.title === '점심')
  assert(state.conflictTitle === null)
  assert(state.conflictCheckFailed === false)
})

Deno.test('dispatchToolCall propose_schedule surfaces a real conflict', async () => {
  const state = newToolDispatchState()
  const existing: ExistingScheduleRow[] = [{
    id: 'a1',
    title: '팀 회의',
    scheduled_date: '2026-08-16',
    start_at: timeOn('2026-08-16', '12:30')!.toISOString(),
    end_at: timeOn('2026-08-16', '13:30')!.toISOString(),
    version: 1,
  }]
  const result: any = await dispatchToolCall(
    fakeSupabase(existing),
    'propose_schedule',
    { title: '점심', date: 'today', startTime: '12:00', endTime: '13:00', isTask: false },
    state,
    dispatchToday,
  )
  assert(result.ok === true)
  assert(result.warning.includes('팀 회의'))
  assert(state.conflictTitle === '팀 회의')
})

Deno.test('dispatchToolCall propose_schedule fails closed when the conflict check itself errors', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeSupabaseError(),
    'propose_schedule',
    { title: '점심', date: 'today', startTime: '12:00', endTime: '13:00', isTask: false },
    state,
    dispatchToday,
  )
  assert(result.ok === false)
  assert(state.conflictCheckFailed === true)
  // Never silently reported as "no conflict" just because the check failed.
  assert(state.conflictTitle === null)
})

Deno.test('dispatchToolCall propose_schedule_update completes against a real target', async () => {
  const state = newToolDispatchState()
  const existing: ExistingScheduleRow[] = [{
    id: 'a1',
    title: '팀 회의',
    scheduled_date: '2026-08-16',
    start_at: null,
    end_at: null,
    version: 3,
  }]
  const result: any = await dispatchToolCall(
    fakeSupabase(existing),
    'propose_schedule_update',
    { id: 'a1', action: 'complete' },
    state,
    dispatchToday,
  )
  assert(result.ok === true)
  assert(state.proposedScheduleUpdate?.title === '팀 회의')
  assert(state.proposedScheduleUpdate?.version === 3)
  assert(state.proposedScheduleUpdate?.action === 'complete')
})

Deno.test('dispatchToolCall propose_schedule_update reports a missing item instead of proposing', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeSupabase([]),
    'propose_schedule_update',
    { id: 'does-not-exist', action: 'delete' },
    state,
    dispatchToday,
  )
  assert(result.ok === false)
  assert(state.proposedScheduleUpdate === null)
})

Deno.test('dispatchToolCall propose_schedule_update reschedule excludes its own row from the conflict check', async () => {
  const state = newToolDispatchState()
  const existing: ExistingScheduleRow[] = [{
    id: 'a1',
    title: '팀 회의',
    scheduled_date: '2026-08-16',
    start_at: timeOn('2026-08-16', '14:00')!.toISOString(),
    end_at: timeOn('2026-08-16', '15:00')!.toISOString(),
    version: 1,
  }]
  const result: any = await dispatchToolCall(
    fakeSupabase(existing),
    'propose_schedule_update',
    { id: 'a1', action: 'reschedule', date: 'today', startTime: '14:00', endTime: '15:00' },
    state,
    dispatchToday,
  )
  assert(result.ok === true)
  assert(state.proposedScheduleUpdate?.conflictTitle === null)
})

Deno.test('dispatchToolCall propose_schedule_update reschedule detects a conflict with a different item', async () => {
  const state = newToolDispatchState()
  const existing: ExistingScheduleRow[] = [
    {
      id: 'a1',
      title: '팀 회의',
      scheduled_date: '2026-08-16',
      start_at: null,
      end_at: null,
      version: 1,
    },
    {
      id: 'b2',
      title: '점심 약속',
      scheduled_date: '2026-08-16',
      start_at: timeOn('2026-08-16', '12:00')!.toISOString(),
      end_at: timeOn('2026-08-16', '13:00')!.toISOString(),
      version: 1,
    },
  ]
  const result: any = await dispatchToolCall(
    fakeSupabase(existing),
    'propose_schedule_update',
    { id: 'a1', action: 'reschedule', date: 'today', startTime: '12:30', endTime: '13:30' },
    state,
    dispatchToday,
  )
  assert(result.ok === true)
  assert(result.warning.includes('점심 약속'))
  assert(state.proposedScheduleUpdate?.conflictTitle === '점심 약속')
})

Deno.test('dispatchToolCall search_schedules and find_free_slots delegate correctly', async () => {
  const state = newToolDispatchState()
  const existing: ExistingScheduleRow[] = [{
    id: 'a1',
    title: '팀 회의',
    scheduled_date: '2026-08-16',
    start_at: timeOn('2026-08-16', '09:00')!.toISOString(),
    end_at: timeOn('2026-08-16', '10:00')!.toISOString(),
    version: 1,
  }]

  const searchResult: any = await dispatchToolCall(
    fakeSupabase(existing),
    'search_schedules',
    { from: '2026-08-16', to: '2026-08-16' },
    state,
    dispatchToday,
  )
  assert(searchResult.items.length === 1)
  assert(searchResult.items[0].title === '팀 회의')

  const freeSlotsResult: any = await dispatchToolCall(
    fakeSupabase(existing),
    'find_free_slots',
    { scope: '2026-08-16', durationMinutes: 30 },
    state,
    dispatchToday,
  )
  assert(typeof freeSlotsResult.slots[0] === 'string')
})

Deno.test('dispatchToolCall reports an unknown tool name instead of throwing', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeSupabase([]),
    'not_a_real_tool',
    {},
    state,
    dispatchToday,
  )
  assert(result.error === 'unknown tool')
})
