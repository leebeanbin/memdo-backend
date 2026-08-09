import { z } from 'zod'

export const ruleSelect =
  'id,calendar_id,title,entry_kind,is_all_day,note,start_time,end_time,time_bucket,reminder_offset_minutes,frequency,step_interval,anchor_date,until_date,occurrence_count,timezone_offset_minutes,created_at,updated_at'

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
    context.addIssue({
      code: 'custom',
      path: ['endTime'],
      message: 'endTime must follow startTime',
    })
  }
  if (value.untilDate && value.untilDate < value.anchorDate) {
    context.addIssue({
      code: 'custom',
      path: ['untilDate'],
      message: 'untilDate must not precede anchorDate',
    })
  }
})

export type ScheduleRuleInput = z.infer<typeof scheduleRuleInputSchema>

// --- Date helpers (UTC noon avoids DST edge cases on day math) -----------------

function ymd(date: string): [number, number, number] {
  const [year, month, day] = date.split('-').map(Number)
  return [year, month, day]
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${
    String(day).padStart(2, '0')
  }`
}

function dayNumber(date: string): number {
  const [year, month, day] = ymd(date)
  return Math.floor(Date.UTC(year, month - 1, day, 12) / 86_400_000)
}

function fromDayNumber(value: number): string {
  const date = new Date(value * 86_400_000 + 12 * 3_600_000)
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

export function addDays(date: string, days: number): string {
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

export type RecurrenceFields = {
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

/**
 * The single next occurrence strictly after `afterDate`, or null if the
 * series has ended (count/untilDate exhausted). Used for task-mode rules,
 * which materialize one occurrence at a time instead of a bulk window.
 */
/** A fixed 2-year search window misses the next occurrence of any rule whose
 * interval is large enough to jump past it (e.g. every 3 years, every 25
 * months) -- the series would silently end on the first completion. Size the
 * window to the rule's own cadence instead. */
function searchWindowDays(frequency: string, interval: number): number {
  const unitDays = frequency === 'yearly' ? 366 : frequency === 'monthly' ? 31 : 7
  return Math.max(732, interval * unitDays * 2 + 366)
}

export function nextOccurrenceAfter(rule: RecurrenceFields, afterDate: string): string | null {
  const searchStart = addDays(afterDate, 1)
  const searchEnd = addDays(afterDate, searchWindowDays(rule.frequency, rule.interval))
  return expandOccurrences(rule, searchStart, searchEnd)[0] ?? null
}

/** The rule's own first valid occurrence on/after its anchor date -- not
 * necessarily the anchor date itself (e.g. a 'weekdays' rule anchored on a
 * Saturday should materialize the following Monday, not the Saturday). */
export function firstOccurrence(rule: RecurrenceFields): string | null {
  const searchEnd = addDays(rule.anchorDate, searchWindowDays(rule.frequency, rule.interval))
  return expandOccurrences(rule, rule.anchorDate, searchEnd)[0] ?? null
}

/** Deterministic id for a rule+date pair, so re-materializing the same
 * occurrence (retry, or virtual -> real promotion) is naturally idempotent. */
export async function occurrenceId(ruleId: string, date: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ruleId}:${date}`)),
  ).slice(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x40
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`
}

/** Builds a real todos row for one occurrence of `rule` on `date`, from the
 * rule's own persisted (snake_case) column values -- shared by rules POST
 * (task-mode's initial occurrence), todos PATCH (task-mode's next-on-completion),
 * and the event-mode virtual-occurrence-touched-so-materialize path. */
export async function materializeRow(
  rule: Record<string, unknown>,
  date: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const startTime = rule.start_time as string | null
  const endTime = rule.end_time as string | null
  const timezoneOffsetMinutes = rule.timezone_offset_minutes as number
  return {
    id: await occurrenceId(rule.id as string, date),
    user_id: userId,
    calendar_id: rule.calendar_id,
    scheduled_date: date,
    title: rule.title,
    entry_kind: rule.entry_kind,
    is_all_day: rule.is_all_day,
    note: rule.note ?? null,
    start_at: startTime ? localInstant(date, startTime, timezoneOffsetMinutes) : null,
    end_at: endTime ? localInstant(date, endTime, timezoneOffsetMinutes) : null,
    time_bucket: rule.time_bucket,
    reminder_offset_minutes: rule.reminder_offset_minutes ?? null,
    status: 'planned',
    progress: 0,
    completed_at: null,
    source: 'recurring',
    is_recurrence_exception: false,
    schedule_rule_id: rule.id,
    sort_order: 0,
    version: 1,
  }
}

/** DTO-shaped (camelCase, matches todoDto's output) but not backed by any todos
 * row -- computed purely from the rule for display. version: 0 is a sentinel a
 * client can use to detect "not real yet" (real rows start at version 1). Kept
 * in sync with todoDto by hand since importing across _shared modules for one
 * shared shape isn't worth the coupling. */
export async function virtualOccurrenceDto(
  rule: Record<string, unknown>,
  date: string,
): Promise<Record<string, unknown>> {
  const startTime = rule.start_time as string | null
  const endTime = rule.end_time as string | null
  const timezoneOffsetMinutes = rule.timezone_offset_minutes as number
  return {
    id: await occurrenceId(rule.id as string, date),
    scheduledDate: date,
    calendarId: rule.calendar_id,
    title: rule.title,
    entryKind: rule.entry_kind,
    isAllDay: rule.is_all_day,
    note: rule.note,
    emoji: null,
    color: null,
    startAt: startTime ? localInstant(date, startTime, timezoneOffsetMinutes) : null,
    endAt: endTime ? localInstant(date, endTime, timezoneOffsetMinutes) : null,
    dueAt: null,
    location: null,
    timeBucket: rule.time_bucket,
    estimatedMinutes: null,
    reminderOffsetMinutes: rule.reminder_offset_minutes,
    sortOrder: 0,
    status: 'planned',
    progress: 0,
    source: 'recurring',
    isRecurrenceException: false,
    dailyPlanId: null,
    scheduleRuleId: rule.id,
    isVirtual: true,
    rescheduledFromId: null,
    version: 0,
    completedAt: null,
    deletedAt: null,
    createdAt: null,
    updatedAt: null,
  }
}
