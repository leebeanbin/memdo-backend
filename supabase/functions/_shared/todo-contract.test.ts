import { decodeTodoCursor, encodeTodoCursor, todoInputSchema } from './todo-contract.ts'

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
