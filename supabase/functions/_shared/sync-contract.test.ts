import { decodeSyncCursor, encodeSyncCursor, syncItem } from './sync-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('sync cursor round trips on sync_seq', () => {
  const row = {
    updated_at: '2026-08-03T12:30:45.123Z',
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    sync_seq: 4213,
  }
  const decoded = decodeSyncCursor(encodeSyncCursor(row))
  assert(decoded?.syncSeq === row.sync_seq)
})

Deno.test('decodeSyncCursor rejects a pre-sync_seq (updated_at, id) cursor', () => {
  // A cursor issued before this migration has no syncSeq -- must fail
  // closed (sync/index.ts turns this into a 400, prompting a fresh sync)
  // rather than silently treating undefined as "no lower bound," which
  // would replay every row.
  const legacy = btoa(JSON.stringify({
    updatedAt: '2026-08-03T12:30:45.123Z',
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
  })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  assert(decodeSyncCursor(legacy) === null)
})

Deno.test('deleted sync item is a minimal tombstone', () => {
  const item = syncItem({
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    version: 3,
    updated_at: '2026-08-03T12:30:45.123Z',
    deleted_at: '2026-08-03T12:30:45.123Z',
  }, 'todo')
  assert(item.operation === 'delete')
  assert(item.data === null)
})

Deno.test('todo sync item derives emoji/color from the passed category (bd18/bd26)', () => {
  const item = syncItem(
    {
      id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
      version: 1,
      updated_at: '2026-08-03T12:30:45.123Z',
      deleted_at: null,
      category_id: 'cat-1',
      emoji: null,
      color: null,
    },
    'todo',
    { emoji: '📚', color: 'sky' },
  )
  assert(item.operation === 'upsert')
  if (item.entityType !== 'todo') throw new Error('expected a todo item')
  assert(item.data?.emoji === '📚')
  assert(item.data?.color === 'sky')
})

Deno.test('workout sync item has no version/delete concept (bd26)', () => {
  const item = syncItem({
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    updated_at: '2026-08-03T12:30:45.123Z',
    activity_type: 'running',
  }, 'workout')
  if (item.entityType !== 'workout') throw new Error('expected a workout item')
  assert(item.operation === 'upsert')
  assert(!('version' in item))
  assert(item.data.activityType === 'running')
})

Deno.test('category sync item upserts when not deleted (bd26)', () => {
  const item = syncItem({
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    updated_at: '2026-08-03T12:30:45.123Z',
    deleted_at: null,
    name: '운동',
    emoji: '🏃',
    color: 'coral',
    is_task_kind: true,
  }, 'category')
  if (item.entityType !== 'category') throw new Error('expected a category item')
  assert(item.operation === 'upsert')
  assert(!('version' in item))
  assert(item.data?.name === '운동')
})

Deno.test('category sync item is a tombstone once soft-deleted (bd26)', () => {
  const item = syncItem({
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    updated_at: '2026-08-03T12:30:45.123Z',
    deleted_at: '2026-08-03T12:30:45.123Z',
    name: '운동',
    emoji: '🏃',
    color: 'coral',
    is_task_kind: true,
  }, 'category')
  assert(item.operation === 'delete')
  assert(item.data === null)
})
