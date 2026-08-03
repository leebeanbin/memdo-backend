import {
  decodeTodoCursor,
  encodeTodoCursor,
  todoInputSchema,
  todoRescheduleSchema,
  todoUpdate,
  todoUpdateSchema,
} from './todo-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('todo input accepts a timed event', () => {
  const result = todoInputSchema.safeParse({
    scheduledDate: '2026-08-02',
    calendarId: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    title: '디자인 검토',
    entryKind: 'event',
    isAllDay: false,
    startAt: '2026-08-02T10:00:00+09:00',
    endAt: '2026-08-02T11:00:00+09:00',
    timeBucket: 'morning',
  })

  assert(result.success)
  assert(result.data.sortOrder === 0)
})

Deno.test('todo input rejects an event deadline', () => {
  const result = todoInputSchema.safeParse({
    scheduledDate: '2026-08-02',
    calendarId: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    title: '잘못된 일정',
    entryKind: 'event',
    startAt: '2026-08-02T10:00:00+09:00',
    endAt: '2026-08-02T11:00:00+09:00',
    dueAt: '2026-08-02T12:00:00+09:00',
    timeBucket: 'morning',
  })

  assert(!result.success)
})

Deno.test('todo cursor round trips', () => {
  const cursor = encodeTodoCursor({
    scheduled_date: '2026-08-02',
    sort_order: 3,
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
  })

  assert(decodeTodoCursor(cursor)?.sortOrder === 3)
  assert(decodeTodoCursor('invalid') === null)
})

Deno.test('todo update requires an optimistic-lock version', () => {
  const result = todoUpdateSchema.safeParse({
    scheduledDate: '2026-08-02',
    calendarId: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    title: '디자인 검토',
    entryKind: 'task',
    isAllDay: false,
    timeBucket: 'anytime',
    status: 'completed',
  })

  assert(!result.success)
})

Deno.test('completed update advances version and progress together', () => {
  const input = todoUpdateSchema.parse({
    scheduledDate: '2026-08-02',
    calendarId: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    title: '디자인 검토',
    entryKind: 'task',
    isAllDay: false,
    timeBucket: 'anytime',
    version: 2,
    status: 'completed',
  })
  const update = todoUpdate(input)

  assert(update.version === 3)
  assert(update.progress === 100)
  assert(typeof update.completed_at === 'string')
})

Deno.test('reschedule requires complete event timing', () => {
  const result = todoRescheduleSchema.safeParse({
    baseVersion: 2,
    entryKind: 'event',
    scheduledDate: '2026-08-04',
    startAt: null,
    endAt: null,
    dueAt: null,
  })
  assert(!result.success)
})

Deno.test('reschedule accepts an untimed task', () => {
  const result = todoRescheduleSchema.safeParse({
    baseVersion: 2,
    entryKind: 'task',
    scheduledDate: '2026-08-04',
    startAt: null,
    endAt: null,
    dueAt: '2026-08-04T12:00:00+09:00',
  })
  assert(result.success)
})
