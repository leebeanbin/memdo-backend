import { z } from 'zod'

export const summaryQuerySchema = z.object({
  scope: z.enum(['today', 'week', 'month']),
  localDate: z.iso.date(),
})

export type SummaryQuery = z.infer<typeof summaryQuerySchema>

export const reviewInputSchema = z.object({
  reflection: z.string().max(2000).nullable().optional(),
})

export type ReviewInput = z.infer<typeof reviewInputSchema>

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12))
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${
    String(shifted.getUTCMonth() + 1).padStart(2, '0')
  }-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

/**
 * Half-open `[start, end)` date range for a summary scope, matching the iOS
 * SummaryScope: today is the single day; week/month are the trailing 7/30 days
 * ending before today (retrospective windows).
 */
export function summaryRange(scope: string, localDate: string): { start: string; end: string } {
  switch (scope) {
    case 'week':
      return { start: addDays(localDate, -7), end: localDate }
    case 'month':
      return { start: addDays(localDate, -30), end: localDate }
    default:
      return { start: localDate, end: addDays(localDate, 1) }
  }
}
