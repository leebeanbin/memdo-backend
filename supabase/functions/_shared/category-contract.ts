import { z } from 'zod'

export const categorySchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(30),
  emoji: z.string().min(1).max(8),
  color: z.enum(['coral', 'amber', 'sage', 'sky', 'indigo', 'violet']),
  isTaskKind: z.boolean(),
})

export const categoriesReplaceSchema = z.object({
  categories: z.array(categorySchema).max(200),
})

export type CategoryInput = z.infer<typeof categorySchema>

export const categorySelect = 'id,name,emoji,color,is_task_kind,sort_order'

export function categoryDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    isTaskKind: row.is_task_kind,
  }
}

export function categoryRow(input: CategoryInput, userId: string, sortOrder: number) {
  return {
    id: input.id,
    user_id: userId,
    name: input.name,
    emoji: input.emoji,
    color: input.color,
    is_task_kind: input.isTaskKind,
    sort_order: sortOrder,
  }
}
