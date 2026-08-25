import { AGENT_TOOL_NAMES, parseAgentToolCall } from './agent-tool-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

function assertValid(toolName: string, args: unknown): void {
  const result = parseAgentToolCall(toolName, args)
  if (!result.ok) {
    throw new Error(`expected valid, got ${result.kind}: ${JSON.stringify(args)}`)
  }
}

function assertInvalid(toolName: string, args: unknown): void {
  const result = parseAgentToolCall(toolName, args)
  if (result.ok) throw new Error(`expected INVALID_ARGUMENT, got ok: ${JSON.stringify(args)}`)
  assert(result.kind === 'INVALID_ARGUMENT')
}

// ── One valid case per tool -- confirms the schemas aren't accidentally
// rejecting the shapes the real handlers actually need. ──

Deno.test('parseAgentToolCall accepts a valid call for every tool', () => {
  assertValid(AGENT_TOOL_NAMES.searchSchedules, { from: '2026-08-16', to: '2026-08-20' })
  assertValid(AGENT_TOOL_NAMES.findFreeSlots, { scope: 'today', durationMinutes: 30 })
  assertValid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '점심',
    date: 'today',
    startTime: '12:00',
    endTime: '13:00',
    isTask: false,
  })
  assertValid(AGENT_TOOL_NAMES.proposeSchedule, { title: '장보기', date: 'tomorrow', isTask: true })
  assertValid(AGENT_TOOL_NAMES.proposeScheduleUpdate, { id: 'a1', action: 'complete' })
  assertValid(AGENT_TOOL_NAMES.proposeScheduleUpdate, { id: 'a1', action: 'delete' })
  assertValid(AGENT_TOOL_NAMES.proposeScheduleUpdate, {
    id: 'a1',
    action: 'reschedule',
    date: 'tomorrow',
    startTime: '09:00',
  })
  assertValid(AGENT_TOOL_NAMES.getDayContext, {})
  assertValid(AGENT_TOOL_NAMES.getDayContext, { date: 'yesterday' })
  assertValid(AGENT_TOOL_NAMES.getRoutinePreferences, {})
  assertValid(AGENT_TOOL_NAMES.getReviewHistory, { limit: 5 })
  assertValid(AGENT_TOOL_NAMES.proposeRoutineUpdate, {
    dailyReviewEnabled: true,
    dailyReviewTime: '21:00',
  })
  assertValid(AGENT_TOOL_NAMES.proposeReviewActions, {
    date: 'yesterday',
    reflection: '집중이 잘 됐다',
  })
  assertValid(AGENT_TOOL_NAMES.requestClarification, { question: '몇 시에 만나고 싶으세요?' })
  assertValid(AGENT_TOOL_NAMES.requestClarification, {
    question: '몇 시에 만나고 싶으세요?',
    missingFields: ['startTime'],
    reason: '시간 없음',
  })
})

Deno.test('parseAgentToolCall rejects request_clarification with no question', () => {
  assertInvalid(AGENT_TOOL_NAMES.requestClarification, {})
  assertInvalid(AGENT_TOOL_NAMES.requestClarification, { question: '' })
})

Deno.test('parseAgentToolCall rejects request_clarification with too many missingFields', () => {
  assertInvalid(AGENT_TOOL_NAMES.requestClarification, {
    question: '몇 시에 만나고 싶으세요?',
    missingFields: ['a', 'b', 'c', 'd', 'e', 'f'],
  })
})

// ── The invalid values called out explicitly in the Sprint 1 plan/doc 20
// §5-1 audit -- each must be rejected, not silently coerced or defaulted. ──

Deno.test('parseAgentToolCall rejects an impossible calendar date', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '치과',
    date: '2026-99-40',
    isTask: false,
    startTime: '15:00',
  })
})

Deno.test('parseAgentToolCall rejects a non-date date token', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '치과',
    date: 'banana',
    isTask: false,
    startTime: '15:00',
  })
})

Deno.test('parseAgentToolCall rejects a malformed time', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '치과',
    date: 'today',
    isTask: false,
    startTime: '25:80',
  })
})

Deno.test('parseAgentToolCall rejects an unrecognized free-slot scope', () => {
  assertInvalid(AGENT_TOOL_NAMES.findFreeSlots, { scope: 'someday', durationMinutes: 30 })
})

Deno.test('parseAgentToolCall rejects a free-slot duration above the 480-minute ceiling', () => {
  assertInvalid(AGENT_TOOL_NAMES.findFreeSlots, { scope: 'today', durationMinutes: 999999 })
})

Deno.test('parseAgentToolCall rejects a free-slot duration below the 15-minute floor', () => {
  assertInvalid(AGENT_TOOL_NAMES.findFreeSlots, { scope: 'today', durationMinutes: 5 })
})

Deno.test('parseAgentToolCall requires date for a reschedule action', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleUpdate, { id: 'a1', action: 'reschedule' })
})

Deno.test('parseAgentToolCall rejects complete/delete carrying reschedule-only fields (strict)', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleUpdate, {
    id: 'a1',
    action: 'complete',
    date: 'tomorrow',
    startTime: '17:00',
  })
})

Deno.test('parseAgentToolCall rejects endTime without startTime', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    date: 'today',
    isTask: false,
    endTime: '13:00',
  })
})

Deno.test('parseAgentToolCall rejects endTime at or before startTime', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    date: 'today',
    isTask: false,
    startTime: '13:00',
    endTime: '13:00',
  })
})

Deno.test('parseAgentToolCall rejects a non-task event with no startTime', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, { title: '회의', date: 'today', isTask: false })
})

Deno.test('parseAgentToolCall rejects a search range where to precedes from', () => {
  assertInvalid(AGENT_TOOL_NAMES.searchSchedules, { from: '2026-12-31', to: '2026-01-01' })
})

Deno.test('parseAgentToolCall reports UNSUPPORTED_TOOL for an unregistered tool name', () => {
  const result = parseAgentToolCall('not_a_real_tool', {})
  assert(!result.ok)
  assert(result.kind === 'UNSUPPORTED_TOOL')
})

Deno.test('parseAgentToolCall normalizes issues to {field, reason}, not raw ZodIssue objects', () => {
  const result = parseAgentToolCall(AGENT_TOOL_NAMES.findFreeSlots, {
    scope: 'someday',
    durationMinutes: 30,
  })
  assert(!result.ok && result.kind === 'INVALID_ARGUMENT')
  if (result.ok || result.kind !== 'INVALID_ARGUMENT') throw new Error('unreachable')
  assert(result.issues.length > 0)
  for (const issue of result.issues) {
    assert(typeof issue.field === 'string')
    assert(typeof issue.reason === 'string')
    assert(Object.keys(issue).sort().join(',') === 'field,reason')
  }
})
