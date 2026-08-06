import { z } from 'zod'

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const scheduleRuleInputSchema = z.object({
  calendarId: z.uuid(),
  title: z.string().trim().min(1).max(120),
  entryKind: z.enum(['event', 'task']),
  isAllDay: z.boolean().default(false),
  note: z.string().max(2000).nullable().optional(),
  startTime: localTime.nullable().optional(),
  endTime: localTime.nullable().optional(),
  timeBucket: z.enum(['morning', 'afternoon', 'evening', 'anytime']),
  reminderOffsetMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  frequency: z.enum(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(52).default(1),
  anchorDate: z.iso.date(),
  untilDate: z.iso.date().nullable().optional(),
  count: z.number().int().min(1).max(730).nullable().optional(),
  timezoneOffsetMinutes: z.number().int().min(-720).max(840),
}).superRefine((value, context) => {
  if (value.entryKind === 'event' && (!value.startTime || !value.endTime)) {
    context.addIssue({ code: 'custom', message: 'Event requires startTime and endTime' })
  }
  if (value.startTime && value.endTime && value.endTime <= value.startTime) {
    context.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime must follow startTime' })
  }
  if (value.untilDate && value.untilDate < value.anchorDate) {
    context.addIssue({ code: 'custom', path: ['untilDate'], message: 'untilDate must not precede anchorDate' })
  }
})

export type ScheduleRuleInput = z.infer<typeof scheduleRuleInputSchema>

// --- Date helpers (UTC noon avoids DST edge cases on day math) -----------------

function ymd(date: string): [number, number, number] {
  const [year, month, day] = date.split('-').map(Number)
  return [year, month, day]
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function dayNumber(date: string): number {
  const [year, month, day] = ymd(date)
  return Math.floor(Date.UTC(year, month - 1, day, 12) / 86_400_000)
}

function fromDayNumber(value: number): string {
  const date = new Date(value * 86_400_000 + 12 * 3_600_000)
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0, 12)).getUTCDate()
}

function addMonths(date: string, months: number): string {
  const [year, month, day] = ymd(date)
  const total = year * 12 + (month - 1) + months
  const newYear = Math.floor(total / 12)
  const newMonth = (total % 12) + 1
  return iso(newYear, newMonth, Math.min(day, daysInMonth(newYear, newMonth)))
}

function addYears(date: string, years: number): string {
  const [year, month, day] = ymd(date)
  return iso(year + years, month, Math.min(day, daysInMonth(year + years, month)))
}

function isWeekday(date: string): boolean {
  const [year, month, day] = ymd(date)
  const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()
  return weekday >= 1 && weekday <= 5
}

/** Local wall-clock time on `day` converted to a UTC ISO instant. */
export function localInstant(day: string, time: string, timezoneOffsetMinutes: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  return new Date(Date.UTC(year, month - 1, date, hour, minute) - timezoneOffsetMinutes * 60_000)
    .toISOString()
}

type RecurrenceFields = {
  frequency: string
  interval: number
  anchorDate: string
  untilDate?: string | null
  count?: number | null
}

/**
 * Expands a recurrence rule into the occurrence dates that fall within
 * `[from, to]` (inclusive). `count`/`untilDate` bound the whole series
 * regardless of the window; monthly/yearly clamp to the last valid day.
 */
export function expandOccurrences(rule: RecurrenceFields, from: string, to: string): string[] {
  const results: string[] = []
  const interval = Math.max(rule.interval ?? 1, 1)
  const until = rule.untilDate ?? null
  const maxCount = rule.count ?? null
  const cap = 3000

  if (rule.frequency === 'weekdays') {
    let date = rule.anchorDate
    let produced = 0
    for (let index = 0; index < cap; index++) {
      if (dayNumber(date) > dayNumber(to)) break
      if (until && dayNumber(date) > dayNumber(until)) break
      if (maxCount !== null && produced >= maxCount) break
      if (isWeekday(date)) {
        if (dayNumber(date) >= dayNumber(from)) results.push(date)
        produced += 1
      }
      date = addDays(date, 1)
    }
    return results
  }

  const nth = (index: number): string => {
    switch (rule.frequency) {
      case 'daily':
        return addDays(rule.anchorDate, index * interval)
      case 'weekly':
        return addDays(rule.anchorDate, index * interval * 7)
      case 'biweekly':
        return addDays(rule.anchorDate, index * 14)
      case 'monthly':
        return addMonths(rule.anchorDate, index * interval)
      case 'yearly':
        return addYears(rule.anchorDate, index * interval)
      default:
        return rule.anchorDate
    }
  }

  for (let index = 0; index < cap; index++) {
    if (maxCount !== null && index >= maxCount) break
    const date = nth(index)
    if (dayNumber(date) > dayNumber(to)) break
    if (until && dayNumber(date) > dayNumber(until)) break
    if (dayNumber(date) >= dayNumber(from)) results.push(date)
  }
  return results
}
