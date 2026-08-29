import { z } from 'zod'
import { todoDto } from './todo-contract.ts'

// A (updated_at, id) cursor used to be able to permanently skip a row:
// set_updated_at() writes now() (transaction *start* time, not commit
// time), so two concurrent writes -- exactly what an offline outbox flush
// produces -- can commit out of timestamp order, and a client syncing in
// between advances its cursor past a row whose transaction hadn't
// committed yet. todos.sync_seq (20260829083831_todos_sync_seq.sql) is
// assigned by nextval() inside its own trigger, so it's only ever handed
// out once, in true commit order -- a single monotonic column, no
// secondary tie-breaker needed. Found via founder-dogfooding code review.
const syncCursorSchema = z.object({
  syncSeq: z.number().int(),
})

export const syncQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(200).default(200),
})

export type SyncCursor = z.infer<typeof syncCursorSchema>

export function decodeSyncCursor(cursor: string): SyncCursor | null {
  try {
    const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/')
    return syncCursorSchema.parse(JSON.parse(atob(base64)))
  } catch {
    return null
  }
}

export function encodeSyncCursor(row: Record<string, unknown>): string {
  return btoa(JSON.stringify({ syncSeq: row.sync_seq }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

export function syncItem(row: Record<string, unknown>) {
  const deletedAt = row.deleted_at as string | null
  return {
    entityType: 'todo',
    operation: deletedAt ? 'delete' : 'upsert',
    id: row.id,
    version: row.version,
    updatedAt: row.updated_at,
    data: deletedAt ? null : todoDto(row),
  }
}
