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
    entryKind: 'event',
    scheduledDate: 'today',
    startTime: '12:00',
    endTime: '13:00',
  })
  assertValid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '장보기',
    entryKind: 'task',
    scheduledDate: 'tomorrow',
  })
  assertValid(AGENT_TOOL_NAMES.proposeScheduleBatch, {
    items: [
      { title: '미용실', entryKind: 'event', scheduledDate: 'today', startTime: '10:00' },
      { title: '운동', entryKind: 'task', scheduledDate: 'tomorrow' },
    ],
  })
  assertValid(AGENT_TOOL_NAMES.proposeScheduleUpdate, { id: 'a1', action: 'complete' })
  assertValid(AGENT_TOOL_NAMES.proposeScheduleUpdate, { id: 'a1', action: 'delete' })
  assertValid(AGENT_TOOL_NAMES.proposeScheduleUpdate, {
    id: 'a1',
    action: 'reschedule',
    date: 'tomorrow',
    startTime: '09:00',
  })
  assertValid(AGENT_TOOL_NAMES.proposeScheduleEdit, { id: 'a1', reminderOffsetsMinutes: [10] })
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
    entryKind: 'event',
    scheduledDate: '2026-99-40',
    startTime: '15:00',
  })
})

Deno.test('parseAgentToolCall rejects a non-date date token', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '치과',
    entryKind: 'event',
    scheduledDate: 'banana',
    startTime: '15:00',
  })
})

Deno.test('parseAgentToolCall rejects a malformed time', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '치과',
    entryKind: 'event',
    scheduledDate: 'today',
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
    entryKind: 'event',
    scheduledDate: 'today',
    endTime: '13:00',
  })
})

Deno.test('parseAgentToolCall rejects endTime at or before startTime', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    entryKind: 'event',
    scheduledDate: 'today',
    startTime: '13:00',
    endTime: '13:00',
  })
})

Deno.test('parseAgentToolCall rejects a non-task event with no startTime', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    entryKind: 'event',
    scheduledDate: 'today',
  })
})

// bd4: was max(200) here vs. todoInputSchema's real max(120) -- a 121-200
// char proposal used to stage fine and then fail to save on approval.
Deno.test("parseAgentToolCall rejects a title past todoInputSchema's real 120-char save limit", () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '가'.repeat(121),
    entryKind: 'task',
    scheduledDate: 'today',
  })
})

Deno.test('parseAgentToolCall accepts a title at exactly the 120-char save limit', () => {
  const result = parseAgentToolCall(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '가'.repeat(120),
    entryKind: 'task',
    scheduledDate: 'today',
  })
  assert(result.ok)
})

// ── A1-1: the widened core-Todo-field set (dueDate/dueTime,
// estimatedMinutes, reminderOffsetsMinutes, locationQuery, categoryHint,
// repeat) -- each has a slot now, not silently dropped before it ever
// reaches the proposal card. ──

Deno.test('parseAgentToolCall accepts a task proposal carrying every new A1-1 field', () => {
  assertValid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '보고서 제출',
    entryKind: 'task',
    scheduledDate: 'today',
    dueDate: 'tomorrow',
    dueTime: '18:00',
    estimatedMinutes: 90,
    reminderOffsetsMinutes: [10, 1440],
    locationQuery: '집',
    categoryHint: '업무',
    repeat: 'weekly',
    note: '초안 검토 포함',
  })
})

Deno.test('parseAgentToolCall rejects dueDate/dueTime on an event (task-only)', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    entryKind: 'event',
    scheduledDate: 'today',
    startTime: '10:00',
    dueDate: 'tomorrow',
  })
})

Deno.test('parseAgentToolCall rejects dueTime without dueDate', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '보고서 제출',
    entryKind: 'task',
    scheduledDate: 'today',
    dueTime: '18:00',
  })
})

Deno.test('parseAgentToolCall rejects an unrecognized entryKind', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    entryKind: 'reminder',
    scheduledDate: 'today',
    startTime: '10:00',
  })
})

Deno.test('parseAgentToolCall rejects more than 5 reminderOffsetsMinutes (matches the R1-1 domain cap)', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    entryKind: 'event',
    scheduledDate: 'today',
    startTime: '10:00',
    reminderOffsetsMinutes: [5, 10, 30, 60, 120, 1440],
  })
})

Deno.test('parseAgentToolCall rejects duplicate reminderOffsetsMinutes', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    entryKind: 'event',
    scheduledDate: 'today',
    startTime: '10:00',
    reminderOffsetsMinutes: [10, 10],
  })
})

Deno.test('parseAgentToolCall sorts reminderOffsetsMinutes ascending, same as the domain schema', () => {
  const result = parseAgentToolCall(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    entryKind: 'event',
    scheduledDate: 'today',
    startTime: '10:00',
    reminderOffsetsMinutes: [60, 10, 1440],
  })
  assert(result.ok)
  if (!result.ok) throw new Error('unreachable')
  assert(
    JSON.stringify((result.args as { reminderOffsetsMinutes: number[] }).reminderOffsetsMinutes) ===
      JSON.stringify([10, 60, 1440]),
  )
})

Deno.test('parseAgentToolCall rejects an unrecognized repeat frequency', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeSchedule, {
    title: '회의',
    entryKind: 'event',
    scheduledDate: 'today',
    startTime: '10:00',
    repeat: 'hourly',
  })
})

// ── A2-1: propose_schedule_edit -- field-level edit on an existing item.
// Every field optional except id, but at least one editable field must be
// set (a no-op edit makes no sense); .strict() rejects unrecognized keys
// (e.g. a model confusing this with propose_schedule and sending title/
// scheduledDate) the same way proposeScheduleUpdateArgsSchema does. ──

Deno.test('parseAgentToolCall accepts a propose_schedule_edit with a single field set', () => {
  assertValid(AGENT_TOOL_NAMES.proposeScheduleEdit, { id: 'a1', note: '준비물: 노트북' })
})

Deno.test('parseAgentToolCall accepts a propose_schedule_edit with every editable field set', () => {
  assertValid(AGENT_TOOL_NAMES.proposeScheduleEdit, {
    id: 'a1',
    reminderOffsetsMinutes: [10, 1440],
    dueDate: 'tomorrow',
    dueTime: '18:00',
    estimatedMinutes: 90,
    locationQuery: '강남역',
    categoryHint: '업무',
    note: '초안 검토 포함',
  })
})

Deno.test('parseAgentToolCall accepts an empty reminderOffsetsMinutes array as a real edit (clears all reminders)', () => {
  assertValid(AGENT_TOOL_NAMES.proposeScheduleEdit, { id: 'a1', reminderOffsetsMinutes: [] })
})

Deno.test('parseAgentToolCall rejects a propose_schedule_edit with no editable field set', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleEdit, { id: 'a1' })
})

Deno.test('parseAgentToolCall rejects a propose_schedule_edit with no id', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleEdit, { note: '메모만 있고 id가 없음' })
})

Deno.test('parseAgentToolCall rejects dueTime without dueDate on propose_schedule_edit', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleEdit, { id: 'a1', dueTime: '18:00' })
})

Deno.test('parseAgentToolCall rejects propose_schedule_edit carrying an unrecognized field (strict)', () => {
  // A model confusing this with propose_schedule and sending title/
  // scheduledDate should fail closed, not silently strip them.
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleEdit, {
    id: 'a1',
    title: '새 제목',
    note: '메모',
  })
})

// ── A3-1: propose_schedule_batch -- `items` reuses proposeScheduleArgsSchema
// per item unchanged, so every per-item rule (event needs startTime,
// dueDate is task-only, etc.) applies inside the array too, not just once
// for the call as a whole. ──

Deno.test('parseAgentToolCall rejects an empty propose_schedule_batch items array', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleBatch, { items: [] })
})

Deno.test('parseAgentToolCall rejects a propose_schedule_batch with more than 10 items', () => {
  const items = Array.from(
    { length: 11 },
    (_, i) => ({ title: `할 일 ${i}`, entryKind: 'task', scheduledDate: 'today' }),
  )
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleBatch, { items })
})

Deno.test('parseAgentToolCall accepts a propose_schedule_batch at exactly the 10-item cap', () => {
  const items = Array.from(
    { length: 10 },
    (_, i) => ({ title: `할 일 ${i}`, entryKind: 'task', scheduledDate: 'today' }),
  )
  assertValid(AGENT_TOOL_NAMES.proposeScheduleBatch, { items })
})

Deno.test('parseAgentToolCall rejects propose_schedule_batch when one item in the array is invalid, not just the call as a whole', () => {
  // Second item is an event with no startTime -- same per-item rule
  // proposeScheduleArgsSchema already enforces for a lone propose_schedule
  // call, now proven to reach inside the array too.
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleBatch, {
    items: [
      { title: '미용실', entryKind: 'event', scheduledDate: 'today', startTime: '10:00' },
      { title: '회의', entryKind: 'event', scheduledDate: 'tomorrow' },
    ],
  })
})

Deno.test('parseAgentToolCall rejects propose_schedule_batch missing items entirely', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleBatch, {})
})

Deno.test('parseAgentToolCall rejects propose_schedule_batch carrying an unrecognized top-level field (strict)', () => {
  assertInvalid(AGENT_TOOL_NAMES.proposeScheduleBatch, {
    items: [{ title: '미용실', entryKind: 'task', scheduledDate: 'today' }],
    title: '엉뚱한 필드',
  })
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
