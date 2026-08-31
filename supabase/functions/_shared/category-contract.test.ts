import { categoryRow } from './category-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('categoryRow always clears deleted_at, reviving a previously soft-deleted row (bd26)', () => {
  const row = categoryRow(
    {
      id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
      name: '운동',
      emoji: '🏃',
      color: 'coral',
      isTaskKind: true,
    },
    'user-1',
    0,
  )
  assert(row.deleted_at === null)
})
