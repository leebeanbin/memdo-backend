import {
  decodeTodoCursor,
  encodeTodoCursor,
  fetchCategoriesByIds,
  todoDto,
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
  }, '2026-08-02')

  assert(decodeTodoCursor(cursor)?.sortOrder === 3)
  assert(decodeTodoCursor(cursor)?.virtualThroughDate === '2026-08-02')
  assert(decodeTodoCursor('invalid') === null)
})

// bd12: virtualThroughDate is nullable/absent on the first page -- must
// still round trip cleanly (not rejected, not coerced to a string).
Deno.test('todo cursor round trips with a null virtualThroughDate', () => {
  const cursor = encodeTodoCursor({
    scheduled_date: '2026-08-02',
    sort_order: 3,
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
  }, null)

  assert(decodeTodoCursor(cursor)?.virtualThroughDate == null)
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
  const update = todoUpdate(input, 'planned')

  assert(update.version === 3)
  assert(update.progress === 100)
  assert(typeof update.completed_at === 'string')
})

Deno.test('todoUpdate omits completed_at when the item was already completed (bd14)', () => {
  // Previously completed_at was stamped with `new Date()` unconditionally
  // whenever status is 'completed', so fixing a typo on an already-
  // completed item rewrote its completion timestamp. Omitted here (not
  // set to null) so the PATCH's SET clause never touches the column at
  // all when this isn't a genuine not-completed -> completed transition.
  const input = todoUpdateSchema.parse({
    scheduledDate: '2026-08-02',
    calendarId: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    title: '디자인 검토 (오타 수정)',
    entryKind: 'task',
    isAllDay: false,
    timeBucket: 'anytime',
    version: 5,
    status: 'completed',
  })
  const update = todoUpdate(input, 'completed')

  assert(!('completed_at' in update))
})

Deno.test('todoUpdate stamps completed_at on a genuine not-completed -> completed transition', () => {
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
  assert(typeof todoUpdate(input, 'in_progress').completed_at === 'string')
  assert(typeof todoUpdate(input, null).completed_at === 'string')
})

Deno.test('todoUpdate clears completed_at when status leaves completed', () => {
  const input = todoUpdateSchema.parse({
    scheduledDate: '2026-08-02',
    calendarId: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    title: '디자인 검토',
    entryKind: 'task',
    isAllDay: false,
    timeBucket: 'anytime',
    version: 4,
    status: 'in_progress',
  })
  assert(todoUpdate(input, 'completed').completed_at === null)
})

Deno.test('reschedule requires paired timing', () => {
  const result = todoRescheduleSchema.safeParse({
    baseVersion: 2,
    targetDate: '2026-08-04',
    startAt: null,
    endAt: '2026-08-04T12:00:00+09:00',
    dueAt: null,
    timeBucket: 'morning',
  })
  assert(!result.success)
})

Deno.test('reschedule accepts an untimed task', () => {
  const result = todoRescheduleSchema.safeParse({
    baseVersion: 2,
    targetDate: '2026-08-04',
    startAt: null,
    endAt: null,
    dueAt: '2026-08-04T12:00:00+09:00',
    timeBucket: 'anytime',
  })
  assert(result.success)
})

Deno.test('todoDto derives emoji/color from the category when the todo has no override (bd18)', () => {
  const dto = todoDto({ id: '1', category_id: 'cat-1', emoji: null, color: null }, {
    emoji: '📚',
    color: 'sky',
  })
  assert(dto.emoji === '📚')
  assert(dto.color === 'sky')
  assert(dto.categoryId === 'cat-1')
})

Deno.test('todoDto keeps a per-todo emoji/color override over the category (bd18)', () => {
  const dto = todoDto({ id: '1', category_id: 'cat-1', emoji: '🔥', color: 'amber' }, {
    emoji: '📚',
    color: 'sky',
  })
  assert(dto.emoji === '🔥')
  assert(dto.color === 'amber')
})

Deno.test('todoDto falls back to null with no category and no override (bd18)', () => {
  const dto = todoDto({ id: '1', category_id: null, emoji: null, color: null })
  assert(dto.emoji === null)
  assert(dto.color === null)
  assert(dto.categoryId === null)
})

Deno.test('fetchCategoriesByIds dedupes ids and skips a query when there are none (bd18)', async () => {
  let calls = 0
  const fakeSupabase = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        in: (_col: string, ids: string[]) => {
          calls++
          assert(ids.length === 2)
          return Promise.resolve({
            data: ids.map((id) => ({ id, emoji: '📚', color: 'sky' })),
            error: null,
          })
        },
      }),
    }),
  }
  const map = await fetchCategoriesByIds(fakeSupabase, ['a', 'a', null, 'b', undefined])
  assert(calls === 1)
  assert(map.get('a')?.emoji === '📚')
  assert(map.size === 2)

  const empty = await fetchCategoriesByIds(fakeSupabase, [null, undefined])
  assert(empty.size === 0)
  assert(calls === 1)
})
