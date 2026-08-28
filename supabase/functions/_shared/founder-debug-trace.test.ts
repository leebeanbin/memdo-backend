import {
  type AgentTurnTrace,
  buildFounderDebugTrace,
  type FounderDebugInputToolCall,
} from './founder-debug-trace.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

const trace: AgentTurnTrace = {
  requestedModel: 'openai/gpt-5.4-mini',
  resolvedModel: null,
  latencyMs: 100,
}

function dispatched(entries: FounderDebugInputToolCall[]): FounderDebugInputToolCall[] {
  return entries
}

Deno.test('buildFounderDebugTrace never emits full reflection text (propose_review_actions)', () => {
  const built = buildFounderDebugTrace(
    trace,
    dispatched([{
      name: 'propose_review_actions',
      args: { date: 'today', reflection: '오늘은 정말 힘든 하루였다. 상사와 갈등이 있었고...' },
      result: { ok: true },
    }]),
  )
  const call = built.toolCalls[0]
  assert(
    JSON.stringify(call.args) !==
      JSON.stringify({
        date: 'today',
        reflection: '오늘은 정말 힘든 하루였다. 상사와 갈등이 있었고...',
      }),
  )
  assert(!('reflection' in call.args))
  assert(call.args.reflectionLength === '오늘은 정말 힘든 하루였다. 상사와 갈등이 있었고...'.length)
  assert(call.args.date === 'today')
})

Deno.test('buildFounderDebugTrace never emits full reflection text (get_review_history result)', () => {
  const built = buildFounderDebugTrace(
    trace,
    dispatched([{
      name: 'get_review_history',
      args: { limit: 10 },
      result: {
        reviews: [
          { reviewDate: '2026-08-15', reflection: '매우 사적인 회고 내용' },
          { reviewDate: '2026-08-14', reflection: '또 다른 사적인 내용' },
        ],
      },
    }]),
  )
  const call = built.toolCalls[0]
  const serialized = JSON.stringify(call.result)
  assert(!serialized.includes('사적인'))
  assert(call.result!.count === 2)
  assert(JSON.stringify(call.result!.dates) === JSON.stringify(['2026-08-15', '2026-08-14']))
})

Deno.test('buildFounderDebugTrace never emits full note or title text (propose_schedule)', () => {
  const built = buildFounderDebugTrace(
    trace,
    dispatched([{
      name: 'propose_schedule',
      args: {
        title: '회사 A와의 비밀 협상',
        date: 'tomorrow',
        startTime: '14:00',
        endTime: '15:00',
        isTask: false,
        note: '절대 외부에 공개하면 안 되는 내용',
      },
      result: { ok: true },
    }]),
  )
  const call = built.toolCalls[0]
  const serialized = JSON.stringify(call.args)
  assert(!serialized.includes('비밀 협상'))
  assert(!serialized.includes('외부에 공개'))
  assert(call.args.titleLength === '회사 A와의 비밀 협상'.length)
  assert(call.args.noteLength === '절대 외부에 공개하면 안 되는 내용'.length)
  assert(call.args.date === 'tomorrow')
  assert(call.args.startTime === '14:00')
})

Deno.test('buildFounderDebugTrace never leaks a conflicting item title embedded in a warning string', () => {
  const built = buildFounderDebugTrace(
    trace,
    dispatched([{
      name: 'propose_schedule',
      args: {
        title: '점심 약속',
        date: 'today',
        startTime: '12:00',
        endTime: '13:00',
        isTask: false,
      },
      result: { ok: true, warning: "Conflicts with existing '팀 전체 회의'" },
    }]),
  )
  const call = built.toolCalls[0]
  const serialized = JSON.stringify(call.result)
  assert(!serialized.includes('팀 전체 회의'))
  assert(call.result!.hasConflict === true)
  assert(call.result!.ok === true)
})

Deno.test('buildFounderDebugTrace never emits full titles from search_schedules/get_day_context results', () => {
  const searchCall = buildFounderDebugTrace(
    trace,
    dispatched([{
      name: 'search_schedules',
      args: { from: '2026-08-16', to: '2026-08-20' },
      result: { items: [{ id: 'a1', title: '민감한 일정 제목', scheduledDate: '2026-08-16' }] },
    }]),
  ).toolCalls[0]
  assert(!JSON.stringify(searchCall.result).includes('민감한'))
  assert(searchCall.result!.count === 1)

  const dayContextCall = buildFounderDebugTrace(
    trace,
    dispatched([{
      name: 'get_day_context',
      args: { date: 'today' },
      result: {
        date: '2026-08-16',
        completedCount: 1,
        incompleteCount: 1,
        completed: [{ id: 'a1', title: '완료된 민감한 항목' }],
        incomplete: [{ id: 'a2', title: '미완료 민감한 항목', startAt: null, endAt: null }],
        hasReflection: false,
      },
    }]),
  ).toolCalls[0]
  assert(!JSON.stringify(dayContextCall.result).includes('민감한'))
  assert(dayContextCall.result!.completedCount === 1)
  assert(dayContextCall.result!.incompleteCount === 1)
})

// D2-1 (second-pass review): get_routine_preferences used to pass
// preferencesDto(row) through raw, which made this sanitizer's safety
// depend on every FUTURE field preferences-contract.ts might ever add --
// a real violation of the module's own default-deny invariant, not just a
// hypothetical one. This injects a deliberately sensitive/unexpected
// field a future preferencesDto() change might plausibly add, and proves
// it can never reach the serialized trace regardless of what the real
// handler actually returns.
Deno.test('buildFounderDebugTrace get_routine_preferences never passes an unexpected/sensitive field through', () => {
  const built = buildFounderDebugTrace(
    trace,
    dispatched([{
      name: 'get_routine_preferences',
      args: {},
      result: {
        configured: true,
        timezone: 'Asia/Seoul',
        widgetStyle: 'nextTodo',
        defaultMood: 'focus',
        hideWidgetContent: false,
        notificationsEnabled: true,
        planningPromptTime: '08:00',
        quietHoursStart: null,
        quietHoursEnd: null,
        calendarFilter: ['업무용 캘린더', '개인 일정 - 민감함'],
        dailyReview: { enabled: true, time: '21:00', days: ['MO', 'TU'], includeReflection: true },
        newsBriefing: { enabled: false, localTime: null, days: [] },
        // Not a real preferencesDto() field today -- stands in for
        // whatever narrative/private field a future change might add.
        internalDebugNote: '이건 절대 노출되면 안 되는 내부 메모',
      },
    }]),
  )
  const call = built.toolCalls[0]
  const serialized = JSON.stringify(call.result)
  assert(!serialized.includes('internalDebugNote'))
  assert(!serialized.includes('절대 노출되면'))
  // calendarFilter: raw filter strings must never appear -- count-only.
  assert(!serialized.includes('calendarFilter"'))
  assert(!serialized.includes('업무용 캘린더'))
  assert(!serialized.includes('개인 일정'))
  assert(call.result!.calendarFilterCount === 2)
  // The deliberately-kept structural fields are still present.
  assert(call.result!.configured === true)
  assert(call.result!.timezone === 'Asia/Seoul')
  assert(call.result!.notificationsEnabled === true)
  const dailyReview = call.result!.dailyReview as Record<string, unknown>
  assert(dailyReview.enabled === true)
  assert(dailyReview.time === '21:00')
  assert(dailyReview.includeReflection === true)
  assert(dailyReview.dayCount === 2)
  assert(!('days' in dailyReview))
  const newsBriefing = call.result!.newsBriefing as Record<string, unknown>
  assert(newsBriefing.enabled === false)
  assert(newsBriefing.dayCount === 0)
})

Deno.test('buildFounderDebugTrace get_routine_preferences reports configured:false as-is (no row exists)', () => {
  const built = buildFounderDebugTrace(
    trace,
    dispatched([{ name: 'get_routine_preferences', args: {}, result: { configured: false } }]),
  )
  assert(JSON.stringify(built.toolCalls[0].result) === JSON.stringify({ configured: false }))
})

Deno.test('buildFounderDebugTrace never emits a raw clarification question/reason, only lengths', () => {
  const built = buildFounderDebugTrace(
    trace,
    dispatched([{
      name: 'request_clarification',
      args: {
        question: '지난주 목요일 회의를 몇 시로 옮길까요?',
        missingFields: ['startTime'],
        reason: '사용자가 새 시간을 말하지 않음',
      },
      result: { ok: true },
    }]),
  )
  const call = built.toolCalls[0]
  const serialized = JSON.stringify(call.args)
  assert(!serialized.includes('지난주 목요일'))
  assert(!serialized.includes('사용자가 새 시간'))
  assert(call.args.questionLength === '지난주 목요일 회의를 몇 시로 옮길까요?'.length)
  assert(call.args.missingFieldCount === 1)
})

Deno.test('buildFounderDebugTrace projects an unrecognized tool name to an empty object, never raw passthrough', () => {
  const built = buildFounderDebugTrace(
    trace,
    dispatched([{
      name: 'some_future_tool',
      args: { secretField: 'should never appear' },
      result: { anotherSecret: 'also should never appear' },
    }]),
  )
  const call = built.toolCalls[0]
  assert(JSON.stringify(call.args) === '{}')
  assert(JSON.stringify(call.result) === '{}')
})

Deno.test('buildFounderDebugTrace preserves result-absence (handler never ran to completion)', () => {
  const built = buildFounderDebugTrace(
    trace,
    dispatched([{ name: 'find_free_slots', args: { scope: 'today' } }]),
  )
  assert(!('result' in built.toolCalls[0]))
})

Deno.test('buildFounderDebugTrace carries requestedModel/resolvedModel/latencyMs through unchanged', () => {
  const built = buildFounderDebugTrace(
    { requestedModel: 'openrouter/free', resolvedModel: 'z-ai/glm-5.2:free', latencyMs: 777 },
    dispatched([]),
  )
  assert(built.requestedModel === 'openrouter/free')
  assert(built.resolvedModel === 'z-ai/glm-5.2:free')
  assert(built.latencyMs === 777)
  assert(built.toolCalls.length === 0)
})
