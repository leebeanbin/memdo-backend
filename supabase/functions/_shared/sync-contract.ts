import { z } from 'zod'
import { todoDto } from './todo-contract.ts'

const syncCursorSchema = z.object({
  updatedAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
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
  return btoa(JSON.stringify({ updatedAt: row.updated_at, id: row.id }))
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
