import {
  calendarCreateSchema,
  calendarInsert,
  calendarUpdateSchema,
  calendarUpdateValues,
} from './calendar-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('calendarInsert always creates a custom-purpose calendar (bd26)', () => {
  const input = calendarCreateSchema.parse({ name: '독서 모임' })
  const row = calendarInsert(input, 'user-1')
  assert(row.purpose === 'custom')
  assert(row.user_id === 'user-1')
  assert(row.name === '독서 모임')
  assert(row.sort_order === 0)
})

Deno.test('calendarUpdateValues only includes provided fields (bd26)', () => {
  const input = calendarUpdateSchema.parse({ name: '새 이름' })
  const values = calendarUpdateValues(input)
  assert(values.name === '새 이름')
  assert(!('color_token' in values))
  assert(!('sort_order' in values))
  assert(!('is_visible' in values))
})

Deno.test('calendarUpdateValues treats an explicit null colorToken as a clear (bd26)', () => {
  const input = calendarUpdateSchema.parse({ colorToken: null })
  const values = calendarUpdateValues(input)
  assert('color_token' in values)
  assert(values.color_token === null)
})

Deno.test('calendar name is bounded like every other user-facing name field', () => {
  const tooLong = 'a'.repeat(51)
  assert(!calendarCreateSchema.safeParse({ name: tooLong }).success)
  assert(!calendarUpdateSchema.safeParse({ name: '' }).success)
})
