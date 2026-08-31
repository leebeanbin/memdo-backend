import { z } from 'zod'

const colorToken = z.string().max(50).nullable().optional()

// bd26: POST only ever creates a purpose:'custom' calendar -- personal/work
// stay signup-only (initialize_memdo_user), sidestepping the existing
// partial-unique-index-on-purpose (at most one personal, one work per user)
// for a first cut of this feature.
export const calendarCreateSchema = z.object({
  name: z.string().trim().min(1).max(50),
  colorToken,
  sortOrder: z.number().int().min(0).default(0),
})

// Genuine partial update -- an absent field is left untouched (unlike
// preferences' full-resend convention, calendars have no read-modify-write
// race motivating that here), an explicit null clears colorToken.
export const calendarUpdateSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  colorToken,
  sortOrder: z.number().int().min(0).optional(),
  isVisible: z.boolean().optional(),
})

export type CalendarCreateInput = z.infer<typeof calendarCreateSchema>
export type CalendarUpdateInput = z.infer<typeof calendarUpdateSchema>

export const calendarSelect =
  'id,name,purpose,color_token,is_visible,sort_order,created_at,updated_at'

export function calendarDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    colorToken: row.color_token,
    isVisible: row.is_visible,
    sortOrder: row.sort_order,
    provider: 'memdo',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function calendarInsert(input: CalendarCreateInput, userId: string) {
  return {
    user_id: userId,
    name: input.name,
    purpose: 'custom',
    color_token: input.colorToken ?? null,
    sort_order: input.sortOrder,
  }
}

export function calendarUpdateValues(input: CalendarUpdateInput) {
  const values: Record<string, unknown> = {}
  if (input.name !== undefined) values.name = input.name
  if (input.colorToken !== undefined) values.color_token = input.colorToken
  if (input.sortOrder !== undefined) values.sort_order = input.sortOrder
  if (input.isVisible !== undefined) values.is_visible = input.isVisible
  return values
}
