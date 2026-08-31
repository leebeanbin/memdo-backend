import { z } from 'zod'
import { todoDto } from './todo-contract.ts'
import { workoutLogDto } from './workout-log-contract.ts'

type TodoCategory = { emoji: string; color: string }

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

// bd26: entity-aware -- /sync now merges todos and workout_logs (bare
// entityType:'todo' was the last hardcoded piece). workout_logs has no
// DELETE endpoint (nothing to soft-delete/tombstone) and no version column
// (no optimistic-lock API for it), so those fields are simply absent from
// a workout item's data rather than a placeholder.
export function syncItem(
  row: Record<string, unknown>,
  entity: 'todo' | 'workout',
  category: TodoCategory | null = null,
) {
  if (entity === 'workout') {
    return {
      entityType: 'workout' as const,
      operation: 'upsert' as const,
      id: row.id,
      updatedAt: row.updated_at,
      data: workoutLogDto(row),
    }
  }
  const deletedAt = row.deleted_at as string | null
  return {
    entityType: 'todo' as const,
    operation: deletedAt ? 'delete' as const : 'upsert' as const,
    id: row.id,
    version: row.version,
    updatedAt: row.updated_at,
    data: deletedAt ? null : todoDto(row, category),
  }
}
