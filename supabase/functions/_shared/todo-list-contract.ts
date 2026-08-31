import { addDays, expandOccurrences, ruleSelect, virtualOccurrenceDto } from './rule-contract.ts'

type SupabasePort = { from: (table: string) => any }

// Clamp the virtual-expansion window regardless of what [from, to] the caller
// asked for -- an unbounded range (or one client-supplied by mistake) times
// several event-mode rules would otherwise mean thousands of sequential
// crypto.subtle.digest calls on a single Edge Function request. The client
// never asks for more than ~90 days at a time; 366 comfortably covers a full
// year of browsing in one call.
export const MAX_VIRTUAL_WINDOW_DAYS = 366

/** Computes event-mode occurrences for [from, to] that don't already have a
 * real materialized row, without touching the DB beyond two cheap reads.
 * Was previously inline in todos/index.ts's request handler, reachable only
 * through a live HTTP call -- moved here (mirroring the extraction done for
 * agent-cloud-chat's dispatch logic) so this recurrence-materialization
 * logic is unit-testable against a fake `supabase` port. */
export async function virtualOccurrencesInRange(
  supabase: SupabasePort,
  from: string,
  to: string,
): Promise<{ items: Record<string, unknown>[]; windowEnd: string }> {
  const clampedTo = addDays(from, MAX_VIRTUAL_WINDOW_DAYS) < to
    ? addDays(from, MAX_VIRTUAL_WINDOW_DAYS)
    : to
  const [rules, existing] = await Promise.all([
    // bd21: a deleted rule is soft-deleted, not gone -- without this filter
    // it would keep generating virtual occurrences forever.
    supabase.from('schedule_rules').select(ruleSelect).eq('entry_kind', 'event').is(
      'deleted_at',
      null,
    ),
    // Deliberately not filtering out soft-deleted rows: a deleted occurrence is
    // still "spoken for" and must not regenerate as virtual on the next list --
    // otherwise deleting one occurrence of a recurring event can never stick.
    //
    // Deliberately EXCLUDING exception rows (is_recurrence_exception = true,
    // set by reschedule_todo on the replacement row): a rescheduled occurrence
    // has moved away from the rule's regular pattern and must not suppress the
    // target date's own genuine occurrence -- they're two independent items
    // that happen to land on the same day.
    supabase
      .from('todos')
      .select('schedule_rule_id,scheduled_date')
      .not('schedule_rule_id', 'is', null)
      .eq('is_recurrence_exception', false)
      .gte('scheduled_date', from)
      .lte('scheduled_date', clampedTo),
  ])
  if (rules.error) throw rules.error
  if (existing.error) throw existing.error

  const materialized = new Set(
    (existing.data as { schedule_rule_id: string; scheduled_date: string }[]).map((row) =>
      `${row.schedule_rule_id}:${row.scheduled_date}`
    ),
  )

  const pending: Promise<Record<string, unknown>>[] = []
  for (const rule of rules.data as Record<string, unknown>[]) {
    const dates = expandOccurrences(
      {
        frequency: rule.frequency as string,
        interval: rule.step_interval as number,
        anchorDate: rule.anchor_date as string,
        untilDate: rule.until_date as string | null,
        count: rule.occurrence_count as number | null,
      },
      from,
      clampedTo,
    )
    for (const date of dates) {
      if (materialized.has(`${rule.id}:${date}`)) continue
      pending.push(virtualOccurrenceDto(rule, date))
    }
  }
  return { items: await Promise.all(pending), windowEnd: clampedTo }
}

// Same fixed KST assumption DEFAULT_TIMEZONE_OFFSET_MINUTES (agent-cloud-
// contract.ts) makes elsewhere -- not duplicating that import here (this
// module sits below agent-cloud-contract.ts in the dependency graph) is
// deliberate; a real per-user timezone here is a bigger, separate change
// (see the schedule_rules timezone-storage work).
const GOOGLE_MIRROR_KST_OFFSET_MINUTES = 540

/** Converts a UTC instant to its KST calendar date (yyyy-MM-dd) -- shifting
 * the instant forward by the offset and reading the UTC date of *that*
 * moment gives the KST date without needing a timezone-aware Date API. */
function kstDateString(instant: string): string {
  const shifted = new Date(new Date(instant).getTime() + GOOGLE_MIRROR_KST_OFFSET_MINUTES * 60_000)
  return shifted.toISOString().slice(0, 10)
}

/** Read-only Google Calendar events mirrored into the same list as todos, the
 * same way virtual recurring occurrences are: merged in, never DB-backed
 * from the client's perspective, calendarId points at the synthetic "Google
 * Calendar" entry GET /calendars appends when a connection is active. */
export async function googleMirrorEventsInRange(
  supabase: SupabasePort,
  from: string,
  to: string,
): Promise<Record<string, unknown>[]> {
  // Range filters and scheduledDate used to be computed in raw UTC while
  // everything else here treats "today"/scheduledDate as KST -- an event
  // before ~09:00 KST has a UTC start_at on the *previous* UTC day, so it
  // rendered a day early, and if that previous day was the first day of
  // the requested range, .gt('end_at', ...) (also UTC-midnight) dropped it
  // from the response entirely. Both boundaries now carry an explicit
  // +09:00 offset instead of implicit UTC, and scheduledDate is derived
  // from the KST-shifted instant (found via founder-dogfooding code
  // review, be7).
  const { data, error } = await supabase
    .from('google_calendar_mirror_events')
    .select('id,connection_id,title,is_all_day,start_at,end_at,location_name')
    .lt('start_at', `${to}T23:59:59.999+09:00`)
    .gt('end_at', `${from}T00:00:00.000+09:00`)
  if (error) throw error

  return (data as Record<string, unknown>[]).map((row) => ({
    id: row.id,
    scheduledDate: kstDateString(row.start_at as string),
    calendarId: row.connection_id,
    title: row.title,
    entryKind: 'event',
    isAllDay: row.is_all_day,
    note: null,
    meetingUrl: null,
    categoryId: null,
    emoji: null,
    color: null,
    startAt: row.start_at,
    endAt: row.end_at,
    dueAt: null,
    location: row.location_name ? { name: row.location_name } : null,
    timeBucket: 'anytime',
    estimatedMinutes: null,
    reminderOffsetMinutes: null,
    sortOrder: 0,
    status: 'planned',
    progress: 0,
    source: 'google_calendar',
    isRecurrenceException: false,
    dailyPlanId: null,
    scheduleRuleId: null,
    isVirtual: false,
    rescheduledFromId: null,
    version: 0,
    completedAt: null,
    deletedAt: null,
    createdAt: null,
    updatedAt: null,
  }))
}
