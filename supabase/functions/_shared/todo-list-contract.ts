import { addDays, expandOccurrences, ruleSelect, virtualOccurrenceDto } from './rule-contract.ts'

type SupabasePort = { from: (table: string) => any }

// Clamp the virtual-expansion window regardless of what [from, to] the caller
// asked for -- an unbounded range (or one client-supplied by mistake) times
// several event-mode rules would otherwise mean thousands of sequential
// crypto.subtle.digest calls on a single Edge Function request. The client
// never asks for more than ~90 days at a time; 366 comfortably covers a full
// year of browsing in one call.
export const MAX_VIRTUAL_WINDOW_DAYS = 366

/** bd12: the clamp itself, extracted as a small pure function so it stays
 * unit-tested even though ownership of *applying* it moved to the caller
 * (todos/index.ts computes this once, before paging, rather than
 * virtualOccurrencesInRange re-deriving it on every per-page sub-range). */
export function clampVirtualWindowEnd(from: string, to: string): string {
  const clamped = addDays(from, MAX_VIRTUAL_WINDOW_DAYS)
  return clamped < to ? clamped : to
}

// bd12: page-extension safety valve -- a single calendar date with more
// real todos than this (a pathological volume no realistic personal-app
// day would hit) is allowed to split across two pages rather than
// growing a query unboundedly. Shared with todos/index.ts's page loop.
export const MAX_PAGE_EXTENSION = 500

/** bd12: true when the page's overflow row -- the (limit+1)-th row from an
 * over-fetch -- shares its date with the limit-th row, meaning that
 * date's real todos aren't fully covered by this page yet. The caller
 * should re-fetch with a larger limit (up to MAX_PAGE_EXTENSION) rather
 * than split the date across pages -- splitting a date is exactly what
 * breaks sort-equivalence between a paginated walk and a single unbounded
 * fetch, since a same-date virtual/Google item can only be merge-sorted
 * correctly with real todos that have already been fetched into the same
 * page. Pulled out as its own pure function (rather than left inline in
 * the handler's query loop) purely so this exact decision is unit-testable
 * without a live Supabase client. */
export function pageSplitsADate(
  data: Record<string, unknown>[],
  effectiveLimit: number,
): boolean {
  if (data.length <= effectiveLimit) return false
  return data[effectiveLimit].scheduled_date === data[effectiveLimit - 1].scheduled_date
}

/** bd12: given data over-fetched at some larger limit, and a "frozen"
 * splitDate (the one date whose rows this page is being extended to fully
 * cover), returns the index of the first row whose date is strictly after
 * splitDate -- the correct page cutoff once splitDate's own rows are fully
 * covered -- or null if no such row exists yet in `data` (extension must
 * grow further).
 *
 * Deliberately does NOT reuse pageSplitsADate's "does the *current*
 * boundary split a date" check once extension has started: re-checking
 * whatever date happens to land at each doubled boundary lets a LATER
 * date (B, C, ...) that also has more rows than fit cascade the
 * extension arbitrarily far past what splitDate itself needed -- fixing
 * date A's split could otherwise keep growing the page through B, C, and
 * beyond, up to MAX_PAGE_EXTENSION, even though A only needed a few more
 * rows. Scanning specifically for the first row past the frozen splitDate
 * means only splitDate's own row count determines how far this page
 * extends; whatever comes after it (even another split date) is left
 * entirely for a later page's own, independent extension decision. */
export function firstIndexAfterDate(
  data: Record<string, unknown>[],
  splitDate: unknown,
): number | null {
  const index = data.findIndex((row) => (row.scheduled_date as string) > (splitDate as string))
  return index === -1 ? null : index
}

export interface VirtualRangeForPage {
  /** MAX_VIRTUAL_WINDOW_DAYS-clamped end of the whole request's range --
   * the same value on every page (computed from the original request
   * from/to, not the per-page sub-range). */
  clampedTo: string
  virtualFrom: string
  virtualTo: string
  /** false exactly when virtualFrom > virtualTo -- nothing new to cover
   * this page (only possible once a previous page's boundary already
   * reached clampedTo). virtualTo/clampedTo are still meaningful in this
   * case (see todos/index.ts: virtualTo is still written into the next
   * cursor, stabilizing at clampedTo so the skip keeps firing on every
   * later page too). */
  shouldFetch: boolean
}

/** bd12: pure computation of the virtual/Google-mirror sub-range a single
 * page should cover, and whether there's anything new to fetch at all.
 * Isolated from the live Supabase calls (unlike virtualOccurrencesInRange/
 * googleMirrorEventsInRange, which still need a DB port) so the exact
 * interleaving/clamping invariants -- the resume-at-day-after-cursor
 * boundary, the clampedTo ceiling, and (paired with pageSplitsADate
 * upstream) the same-date sort-equivalence guarantee -- are directly
 * unit-testable against plain values. */
export function virtualRangeForPage(params: {
  requestFrom: string
  requestTo: string
  cursorVirtualThroughDate: string | null | undefined
  /** The current page's last real todo's scheduled_date -- but ONLY when a
   * later page is coming to continue from it (i.e. the caller's hasMore is
   * true). Pass null for an empty page OR the final page (hasMore false):
   * with no later page able to pick up whatever comes after the last real
   * todo, trailing dates within [from, clampedTo] that have no real todos
   * of their own would otherwise never be covered by any page at all. When
   * non-null, this date is always fully covered by real todos for it, by
   * construction -- pageSplitsADate/the extension loop upstream never lets
   * a non-final page end mid-date. */
  pageBoundaryDate: string | null
}): VirtualRangeForPage {
  const clampedTo = clampVirtualWindowEnd(params.requestFrom, params.requestTo)
  // The resume point is the day *after* the stored virtualThroughDate, not
  // the same date -- makes each page's virtual range a true partition of
  // [from, clampedTo], adjacent and non-overlapping, nothing skipped or
  // duplicated across a page boundary.
  const virtualFrom = params.cursorVirtualThroughDate
    ? addDays(params.cursorVirtualThroughDate, 1)
    : params.requestFrom
  // Never exceeds clampedTo, enforced explicitly -- real todos aren't
  // themselves window-clamped, so a huge range's last real todo could
  // otherwise re-expand virtual computation past the exact window the
  // clamp exists to bound.
  const virtualTo = params.pageBoundaryDate && params.pageBoundaryDate < clampedTo
    ? params.pageBoundaryDate
    : clampedTo
  return { clampedTo, virtualFrom, virtualTo, shouldFetch: virtualFrom <= virtualTo }
}

/** Computes event-mode occurrences for exactly [from, to] that don't already
 * have a real materialized row, without touching the DB beyond two cheap
 * reads. Was previously inline in todos/index.ts's request handler,
 * reachable only through a live HTTP call -- moved here (mirroring the
 * extraction done for agent-cloud-chat's dispatch logic) so this
 * recurrence-materialization logic is unit-testable against a fake
 * `supabase` port.
 *
 * bd12: a pure range-computation function with no clamping policy of its
 * own -- MAX_VIRTUAL_WINDOW_DAYS clamping now happens once in the caller
 * (todos/index.ts), before paging, since this is called with a different
 * per-page sub-range on every page rather than the whole request range. */
export async function virtualOccurrencesInRange(
  supabase: SupabasePort,
  from: string,
  to: string,
): Promise<Record<string, unknown>[]> {
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
      .lte('scheduled_date', to),
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
      to,
    )
    for (const date of dates) {
      if (materialized.has(`${rule.id}:${date}`)) continue
      pending.push(virtualOccurrenceDto(rule, date))
    }
  }
  return await Promise.all(pending)
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
