import { decodeSyncCursor, encodeSyncCursor, syncItem } from './sync-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('sync cursor keeps timestamp and id tie breaker', () => {
  const row = {
    updated_at: '2026-08-03T12:30:45.123Z',
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
  }
  const decoded = decodeSyncCursor(encodeSyncCursor(row))
  assert(decoded?.updatedAt === row.updated_at)
  assert(decoded?.id === row.id)
})

Deno.test('deleted sync item is a minimal tombstone', () => {
  const item = syncItem({
    id: '8c7187df-8754-42fe-b70c-3a6876bab9b8',
    version: 3,
    updated_at: '2026-08-03T12:30:45.123Z',
    deleted_at: '2026-08-03T12:30:45.123Z',
  })
  assert(item.operation === 'delete')
  assert(item.data === null)
})
