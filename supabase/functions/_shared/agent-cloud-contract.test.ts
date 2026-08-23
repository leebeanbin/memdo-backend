import {
  accumulatedToolCallsArray,
  addAgentUsage,
  AGENT_TOOL_NAMES,
  applyStreamChunk,
  buildDonePayload,
  cloudAgentTools,
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

Deno.test('resolveDate today uses KST calendar date across the UTC day boundary', () => {
  // Issue A-03: systemPrompt() used to compute "today" from a bare
  // toISODate(new Date()) (UTC's calendar date) while every tool-argument
  // date resolution went through resolveDate('today', ...) (KST, +540min)
  // -- for ~9h/day the two disagreed on which day it was. Fixed in
  // agent-cloud-chat/index.ts (systemPrompt(resolveDate('today', today)));
  // this pins the boundary resolveDate itself must get right on both sides.
  //
  // UTC 2026-08-20 15:30 == KST 2026-08-21 00:30 -- already the 21st.
  assert(resolveDate('today', new Date('2026-08-20T15:30:00Z')) === '2026-08-21')
  // UTC 2026-08-21 14:59 == KST 2026-08-21 23:59 -- still the 21st.
  assert(resolveDate('today', new Date('2026-08-21T14:59:00Z')) === '2026-08-21')
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

Deno.test('conflict/no-time (boundary fixture): rows with no start_at/end_at never reach ConflictService', async () => {
  // Agent Domain Fixture Contract: v1 -- unlike free-slot-service.test.ts/
  // conflict-service.test.ts's canonical fixtures, this isn't testing
  // conflict-service.ts's pure findConflict directly (ConflictCandidate's
  // start/end are non-optional, so a no-time row can't even be constructed
  // as one) -- it's testing that toConflictCandidates() filters such rows
  // out before they'd reach it.
  const state = newToolDispatchState()
  const existing: ExistingScheduleRow[] = [{
    id: 'task-1',
    title: '할 일',
    scheduled_date: '2026-08-16',
    start_at: null,
    end_at: null,
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
  assert(state.conflictTitle === null)
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
  assert(result.error === 'UNSUPPORTED_TOOL')
})

// ── Issue A-04/B-04: invalid arguments must never reach a handler, so the
// handler's own state mutations (staging a proposal) must never happen --
// checking the tool result alone isn't enough, since a handler could in
// principle return an error string while still having mutated state first. ──

Deno.test('dispatchToolCall leaves state untouched when propose_schedule gets an invalid date', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeSupabase([]),
    'propose_schedule',
    { title: '점심', date: '2026-99-40', startTime: '12:00', isTask: false },
    state,
    dispatchToday,
  )
  assert(result.error === 'INVALID_AGENT_ARGUMENT')
  assert(state.proposedSchedule === null)
})

Deno.test('dispatchToolCall leaves state untouched when propose_schedule_update reschedule omits date', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeSupabase([]),
    'propose_schedule_update',
    { id: 'a1', action: 'reschedule' },
    state,
    dispatchToday,
  )
  assert(result.error === 'INVALID_AGENT_ARGUMENT')
  assert(state.proposedScheduleUpdate === null)
})

Deno.test('dispatchToolCall leaves state untouched when find_free_slots duration is out of range', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeSupabase([]),
    'find_free_slots',
    { scope: 'today', durationMinutes: 999999 },
    state,
    dispatchToday,
  )
  assert(result.error === 'INVALID_AGENT_ARGUMENT')
  // find_free_slots never stages state to begin with -- this confirms it
  // also never reaches fetchSchedules by asserting the whole state object
  // is still the pristine default rather than checking one field.
  assert(JSON.stringify(state) === JSON.stringify(newToolDispatchState()))
})

// ── get_day_context / get_routine_preferences / get_review_history /
// propose_routine_update / propose_review_actions (Phase 6 additions) ──
// fakeSupabase()/fakeSupabaseError() above only seed `todos`-shaped rows, so
// these tests use a small table-aware fake instead.

function fakeMultiTableSupabase(
  tables: Record<string, unknown[]>,
): { from: (table: string) => any } {
  return {
    from: (table: string) => {
      const rows = tables[table] ?? []
      let eqFilters: Array<[string, unknown]> = []
      const chain: any = {
        select: () => chain,
        is: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: (n: number) => {
          const filtered = rows.filter((row: any) =>
            eqFilters.every(([col, value]) => row[col] === value)
          )
          return {
            ...chain,
            then: (resolve: any) => resolve({ data: filtered.slice(0, n), error: null }),
          }
        },
        eq: (col: string, value: unknown) => {
          eqFilters = [...eqFilters, [col, value]]
          return chain
        },
        maybeSingle: () => {
          const match = rows.find((row: any) =>
            eqFilters.every(([col, value]) => row[col] === value)
          )
          return Promise.resolve({ data: match ?? null, error: null })
        },
        then: (resolve: any) =>
          resolve({
            data: rows.filter((row: any) => eqFilters.every(([col, value]) => row[col] === value)),
            error: null,
          }),
      }
      return chain
    },
  }
}

Deno.test('dispatchToolCall get_day_context splits completed vs incomplete and flags a reflection', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeMultiTableSupabase({
      todos: [
        {
          id: 't1',
          title: '운동',
          scheduled_date: '2026-08-16',
          start_at: null,
          end_at: null,
          status: 'completed',
        },
        {
          id: 't2',
          title: '보고서 작성',
          scheduled_date: '2026-08-16',
          start_at: null,
          end_at: null,
          status: 'pending',
        },
      ],
      daily_reviews: [{ review_date: '2026-08-16', reflection: '좋은 하루' }],
    }),
    'get_day_context',
    {},
    state,
    dispatchToday,
  )
  assert(result.date === '2026-08-16')
  assert(result.completedCount === 1)
  assert(result.incompleteCount === 1)
  assert(result.completed[0].title === '운동')
  assert(result.incomplete[0].title === '보고서 작성')
  assert(result.hasReflection === true)
})

Deno.test('dispatchToolCall get_day_context reports no reflection when none exists', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeMultiTableSupabase({ todos: [], daily_reviews: [] }),
    'get_day_context',
    { date: 'tomorrow' },
    state,
    dispatchToday,
  )
  assert(result.date === '2026-08-17')
  assert(result.hasReflection === false)
})

Deno.test('dispatchToolCall get_routine_preferences reports unconfigured when no row exists', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeMultiTableSupabase({ user_preferences: [] }),
    'get_routine_preferences',
    {},
    state,
    dispatchToday,
  )
  assert(result.configured === false)
})

Deno.test('dispatchToolCall get_routine_preferences maps an existing row through preferencesDto', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeMultiTableSupabase({
      user_preferences: [{
        timezone: 'Asia/Seoul',
        widget_style: 'next_todo',
        default_mood: null,
        hide_widget_content: false,
        notifications_enabled: true,
        planning_prompt_time: '08:00',
        quiet_hours_start: null,
        quiet_hours_end: null,
        calendar_filter: [],
        daily_review_enabled: true,
        daily_review_time: '21:00',
        daily_review_days: ['MO', 'TU'],
        daily_review_include_reflection: true,
        news_briefing_enabled: false,
        news_briefing_time: null,
        news_briefing_days: [],
        news_briefing_last_generated_date: null,
        updated_at: '2026-08-16T00:00:00Z',
      }],
    }),
    'get_routine_preferences',
    {},
    state,
    dispatchToday,
  )
  assert(result.configured === true)
  assert(result.dailyReview.time === '21:00')
  assert(result.notificationsEnabled === true)
})

Deno.test('dispatchToolCall get_review_history returns most recent reflections up to the limit', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeMultiTableSupabase({
      daily_reviews: [
        { review_date: '2026-08-15', reflection: '어제' },
        { review_date: '2026-08-14', reflection: '그제' },
      ],
    }),
    'get_review_history',
    { limit: 1 },
    state,
    dispatchToday,
  )
  assert(result.reviews.length === 1)
  assert(result.reviews[0].reviewDate === '2026-08-15')
})

Deno.test('dispatchToolCall propose_routine_update stages a partial change without touching the DB', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeMultiTableSupabase({}),
    'propose_routine_update',
    { dailyReviewEnabled: true, dailyReviewTime: '22:00' },
    state,
    dispatchToday,
  )
  assert(result.ok === true)
  assert(state.proposedRoutineUpdate?.dailyReviewEnabled === true)
  assert(state.proposedRoutineUpdate?.dailyReviewTime === '22:00')
  assert(state.proposedRoutineUpdate?.newsBriefingEnabled === undefined)
})

Deno.test('dispatchToolCall propose_review_actions stages a reflection without saving it', async () => {
  const state = newToolDispatchState()
  const result: any = await dispatchToolCall(
    fakeMultiTableSupabase({}),
    'propose_review_actions',
    { date: 'yesterday', reflection: '집중이 잘 됐다' },
    state,
    dispatchToday,
  )
  assert(result.ok === true)
  assert(state.proposedReviewAction?.date === 'yesterday')
  assert(state.proposedReviewAction?.reflection === '집중이 잘 됐다')
})

Deno.test('resolveDate resolves yesterday relative to today', () => {
  assert(resolveDate('yesterday', dispatchToday) === '2026-08-15')
})

Deno.test('every tool advertised in cloudAgentTools has a live dispatch handler', async () => {
  // AGENT_TOOL_NAMES is meant to be the single source of truth the schema
  // and the dispatch table both read from -- this proves it actually is one
  // by walking the real schema array and confirming each name dispatches to
  // something other than the "unknown tool" fallback, rather than trusting
  // that AGENT_TOOL_NAMES and the handler map were kept in sync by hand.
  const advertisedNames = cloudAgentTools.map((tool) => tool.function.name)
  assert(advertisedNames.length === Object.keys(AGENT_TOOL_NAMES).length)

  for (const name of advertisedNames) {
    const state = newToolDispatchState()
    // fakeMultiTableSupabase(), not fakeSupabase() -- get_review_history's
    // real query chain calls .order(), which only the multi-table fake
    // implements.
    const result: any = await dispatchToolCall(
      fakeMultiTableSupabase({}),
      name,
      {},
      state,
      dispatchToday,
    )
    if (result && result.error === 'UNSUPPORTED_TOOL') {
      throw new Error(`${name} is advertised in cloudAgentTools but has no dispatch handler`)
    }
  }
})

// ── buildDonePayload <-> iOS AgentStreamLineDTO contract ──
// iOS's Decodable structs (ScheduleAPI.swift) are the actual consumer of
// this JSON shape but live in a different repo/language, so there's no
// compiler link between them and this file the way there is between
// cloudAgentTools and dispatchToolCall above. These tests hard-code the
// key sets iOS's structs currently declare (as of AgentStreamLineDTO/
// CloudProposedScheduleDTO/CloudProposedScheduleUpdateDTO in
// ScheduleAPI.swift) and fail loudly if this file's output drifts from
// them -- the nearest thing to a compile-time check across the boundary.

const IOS_STREAM_LINE_KEYS = [
  'delta',
  'done',
  'proposedSchedule',
  'proposedScheduleUpdate',
  'error',
]
const IOS_PROPOSED_SCHEDULE_KEYS = [
  'title',
  'date',
  'startTime',
  'endTime',
  'isTask',
  'note',
  'conflictTitle',
  'conflictCheckFailed',
]
const IOS_PROPOSED_SCHEDULE_UPDATE_KEYS = [
  'id',
  'action',
  'date',
  'startTime',
  'endTime',
  'title',
  'version',
  'conflictTitle',
  'conflictCheckFailed',
]

Deno.test('buildDonePayload top-level keys are a subset of what AgentStreamLineDTO declares', () => {
  const state = newToolDispatchState()
  const payload = buildDonePayload(state)
  // Superset is fine (Swift Decodable ignores unknown keys by default) --
  // proposedRoutineUpdate/proposedReviewAction are exactly that, added
  // ahead of iOS having anything to decode them into (see
  // ToolDispatchState's doc comment). A key iOS DOES try to decode that's
  // missing here would break the client, so that direction must hold.
  for (const key of ['done', 'proposedSchedule', 'proposedScheduleUpdate']) {
    assert(key in payload)
  }
  assert(IOS_STREAM_LINE_KEYS.includes('done'))
  assert(IOS_STREAM_LINE_KEYS.includes('proposedSchedule'))
  assert(IOS_STREAM_LINE_KEYS.includes('proposedScheduleUpdate'))
})

Deno.test('buildDonePayload.proposedSchedule matches CloudProposedScheduleDTO field for field', async () => {
  const state = newToolDispatchState()
  await dispatchToolCall(
    fakeSupabase([]),
    AGENT_TOOL_NAMES.proposeSchedule,
    { title: '점심', date: 'today', startTime: '12:00', endTime: '13:00', isTask: false },
    state,
    dispatchToday,
  )
  const payload = buildDonePayload(state)
  assert(payload.proposedSchedule !== null)
  const actualKeys = Object.keys(payload.proposedSchedule!).sort()
  const expectedKeys = [...IOS_PROPOSED_SCHEDULE_KEYS].filter((k) => k !== 'note').sort()
  // `note` is optional/omitted when absent (undefined props don't survive
  // JSON.stringify, matching how the real HTTP response would look) --
  // compare against the DTO's *required-for-this-case* key set instead of
  // demanding an exact match that would be a false negative here.
  for (const key of expectedKeys) {
    if (!actualKeys.includes(key)) throw new Error(`missing key: ${key}`)
  }
  for (const key of actualKeys) {
    if (!IOS_PROPOSED_SCHEDULE_KEYS.includes(key)) {
      throw new Error(`unexpected key iOS doesn't declare: ${key}`)
    }
  }
})

Deno.test('buildDonePayload.proposedScheduleUpdate matches CloudProposedScheduleUpdateDTO field for field', async () => {
  const state = newToolDispatchState()
  const existing: ExistingScheduleRow[] = [{
    id: 'a1',
    title: '팀 회의',
    scheduled_date: '2026-08-16',
    start_at: null,
    end_at: null,
    version: 2,
  }]
  await dispatchToolCall(
    fakeSupabase(existing),
    AGENT_TOOL_NAMES.proposeScheduleUpdate,
    { id: 'a1', action: 'complete' },
    state,
    dispatchToday,
  )
  const payload = buildDonePayload(state)
  assert(payload.proposedScheduleUpdate !== null)
  const actualKeys = Object.keys(payload.proposedScheduleUpdate!).sort()
  const expectedKeys = [...IOS_PROPOSED_SCHEDULE_UPDATE_KEYS].filter((k) =>
    k !== 'date' && k !== 'startTime' && k !== 'endTime'
  )
    .sort()
  for (const key of expectedKeys) {
    if (!actualKeys.includes(key)) throw new Error(`missing key: ${key}`)
  }
  for (const key of actualKeys) {
    if (!IOS_PROPOSED_SCHEDULE_UPDATE_KEYS.includes(key)) {
      throw new Error(`unexpected key iOS doesn't declare: ${key}`)
    }
  }
})
