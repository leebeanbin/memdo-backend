import {
  clampVirtualWindowEnd,
  googleMirrorEventsInRange,
  pageSplitsADate,
  virtualOccurrencesInRange,
  virtualRangeForPage,
} from './todo-list-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

// Chainable no-op query builder that ignores every filter and resolves to
// whatever rows this table was seeded with -- these two functions' own
// logic (which occurrences are already materialized, which mirror events
// overlap the range) is what's under test, not Postgres's filtering.
function fakeSupabase(tables: Record<string, unknown[]>): { from: (table: string) => any } {
  return {
    from: (table: string) => {
      const rows = tables[table] ?? []
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        gt: () => chain,
        then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
          resolve({ data: rows, error: null }),
      }
      return chain
    },
  }
}

const dailyEventRule = {
  id: 'rule-1',
  calendar_id: 'cal-1',
  title: '아침 스트레칭',
  entry_kind: 'event',
  is_all_day: false,
  note: null,
  start_time: '07:00',
  end_time: '07:30',
  time_bucket: 'morning',
  reminder_offset_minutes: null,
  frequency: 'daily',
  step_interval: 1,
  anchor_date: '2026-08-01',
  until_date: null,
  occurrence_count: null,
  timezone: 'Asia/Seoul',
}

Deno.test('virtualOccurrencesInRange generates one occurrence per day for a daily rule', async () => {
  const items = await virtualOccurrencesInRange(
    fakeSupabase({ schedule_rules: [dailyEventRule], todos: [] }),
    '2026-08-16',
    '2026-08-18',
  )
  assert(items.length === 3)
  assert(items.every((item: any) => item.title === '아침 스트레칭'))
})

Deno.test('virtualOccurrencesInRange skips a date that already has a materialized row', async () => {
  const items = await virtualOccurrencesInRange(
    fakeSupabase({
      schedule_rules: [dailyEventRule],
      todos: [{ schedule_rule_id: 'rule-1', scheduled_date: '2026-08-17' }],
    }),
    '2026-08-16',
    '2026-08-18',
  )
  assert(items.length === 2)
  const dates = items.map((item: any) => item.scheduledDate)
  assert(!dates.includes('2026-08-17'))
})

// bd12: clamping moved out of virtualOccurrencesInRange into this small
// pure function, called once by the caller before paging -- still
// unit-tested against the exact same case as before the move.
Deno.test('clampVirtualWindowEnd clamps to MAX_VIRTUAL_WINDOW_DAYS', () => {
  assert(clampVirtualWindowEnd('2026-08-16', '2030-08-16') === '2027-08-17')
})

Deno.test('clampVirtualWindowEnd leaves a range already inside the window untouched', () => {
  assert(clampVirtualWindowEnd('2026-08-16', '2026-08-18') === '2026-08-18')
})

// ── bd12: page-extension + per-page virtual/Google range ─────────────────

Deno.test("pageSplitsADate is true when the peeked row shares the last row's date", () => {
  const data = [
    { scheduled_date: '2026-08-05', sort_order: 0, id: 'a' },
    { scheduled_date: '2026-08-05', sort_order: 1, id: 'b' }, // effectiveLimit=2 boundary
    { scheduled_date: '2026-08-05', sort_order: 2, id: 'c' }, // peeked row, same date
  ]
  assert(pageSplitsADate(data, 2))
})

Deno.test('pageSplitsADate is false when the peeked row is a later date', () => {
  const data = [
    { scheduled_date: '2026-08-05', sort_order: 0, id: 'a' },
    { scheduled_date: '2026-08-05', sort_order: 1, id: 'b' },
    { scheduled_date: '2026-08-06', sort_order: 0, id: 'c' }, // peeked row, different date
  ]
  assert(!pageSplitsADate(data, 2))
})

Deno.test('pageSplitsADate is false when there is no overflow row (last page)', () => {
  const data = [{ scheduled_date: '2026-08-05', sort_order: 0, id: 'a' }]
  assert(!pageSplitsADate(data, 2))
})

Deno.test('virtualRangeForPage: first page (no cursor) starts at requestFrom', () => {
  const range = virtualRangeForPage({
    requestFrom: '2026-08-16',
    requestTo: '2026-08-20',
    cursorVirtualThroughDate: null,
    pageBoundaryDate: '2026-08-17',
  })
  assert(range.virtualFrom === '2026-08-16')
  assert(range.virtualTo === '2026-08-17')
  assert(range.shouldFetch)
})

Deno.test('virtualRangeForPage: resumed page starts the day after the stored virtualThroughDate, not the same date', () => {
  const range = virtualRangeForPage({
    requestFrom: '2026-08-16',
    requestTo: '2026-08-20',
    cursorVirtualThroughDate: '2026-08-17',
    pageBoundaryDate: '2026-08-19',
  })
  assert(range.virtualFrom === '2026-08-18') // not '2026-08-17' -- would duplicate that date
  assert(range.virtualTo === '2026-08-19')
})

Deno.test('virtualRangeForPage: virtualTo never exceeds clampedTo even if the last real todo does', () => {
  const range = virtualRangeForPage({
    requestFrom: '2026-08-16',
    requestTo: '2030-08-16', // 4 years out -- clampedTo is 2027-08-17
    cursorVirtualThroughDate: null,
    pageBoundaryDate: '2029-01-01', // a real todo far past the clamp
  })
  assert(range.clampedTo === '2027-08-17')
  assert(range.virtualTo === '2027-08-17')
})

Deno.test('virtualRangeForPage: the final page (pageBoundaryDate null) covers trailing dates through the full clamp, not just the last real todo', () => {
  // Regression for a real bug caught during implementation: bounding
  // virtualTo by the last real todo's date is only correct when a LATER
  // page is coming to continue from it. On the final page there is no
  // later page, so trailing dates after the last real todo (with no real
  // todos of their own) must be covered here or they're silently dropped.
  const range = virtualRangeForPage({
    requestFrom: '2026-08-16',
    requestTo: '2026-08-25',
    cursorVirtualThroughDate: '2026-08-18',
    pageBoundaryDate: null, // caller passes null on the final page
  })
  assert(range.virtualTo === '2026-08-25')
})

Deno.test('virtualRangeForPage: shouldFetch is false once a previous page already reached clampedTo, and virtualTo stays stable', () => {
  const range = virtualRangeForPage({
    requestFrom: '2026-08-16',
    requestTo: '2026-08-20',
    cursorVirtualThroughDate: '2026-08-20', // already fully covered by an earlier page
    pageBoundaryDate: '2026-08-20',
  })
  assert(!range.shouldFetch)
  assert(range.virtualTo === '2026-08-20')
})

Deno.test('bd12: same-date real todos that would span 3 pages at limit=2, plus a same-date Google item, stay sort-equivalent to a single unbounded fetch', () => {
  // The exact counter-example from review: a single date's real todos
  // spanning multiple pages, with a same-date Google/virtual item that
  // must not land out of order relative to real todos already emitted on
  // an earlier page.
  const realRows = [
    { scheduled_date: '2026-08-05', sort_order: 1, id: 'r1' },
    { scheduled_date: '2026-08-05', sort_order: 2, id: 'r2' },
    { scheduled_date: '2026-08-05', sort_order: 3, id: 'r3' },
    { scheduled_date: '2026-08-05', sort_order: 4, id: 'r4' },
    { scheduled_date: '2026-08-05', sort_order: 5, id: 'r5' },
    { scheduled_date: '2026-08-05', sort_order: 6, id: 'r6' },
  ]
  const googleItem = { scheduledDate: '2026-08-05', sortOrder: 0, id: 'g-11-30' }

  // Simulate todos/index.ts's own page-extension loop against an in-memory
  // table, ordered exactly the way the real Postgres query is.
  const ordered = [...realRows].sort((a, b) =>
    a.scheduled_date.localeCompare(b.scheduled_date) || a.sort_order - b.sort_order ||
    a.id.localeCompare(b.id)
  )
  let effectiveLimit = 2
  let data: typeof ordered = []
  while (true) {
    data = ordered.slice(0, effectiveLimit + 1)
    if (!pageSplitsADate(data, effectiveLimit)) break
    effectiveLimit *= 2
  }
  const items = data.slice(0, effectiveLimit)

  // All 6 real todos ended up on one page -- the date was never split
  // (would have been 3 pages of 2 before the fix).
  assert(items.length === 6)

  const range = virtualRangeForPage({
    requestFrom: '2026-08-05',
    requestTo: '2026-08-05',
    cursorVirtualThroughDate: null,
    pageBoundaryDate: null, // this is also the final page here (hasMore false)
  })
  assert(range.shouldFetch)

  const sortItems = (rows: { scheduledDate: string; sortOrder: number; id: string }[]) =>
    [...rows].sort((a, b) =>
      a.scheduledDate.localeCompare(b.scheduledDate) || a.sortOrder - b.sortOrder ||
      a.id.localeCompare(b.id)
    )

  const paginatedMerged = sortItems([
    ...items.map((r) => ({ scheduledDate: r.scheduled_date, sortOrder: r.sort_order, id: r.id })),
    googleItem,
  ])
  // Sort-equivalence: byte-for-byte identical, in order, to merging ALL
  // items (real + google) in one shot with no pagination at all -- the
  // exact guarantee bd12 promises, not merely "the right items eventually
  // show up somewhere."
  const singleFetchMerged = sortItems([
    ...realRows.map((r) => ({
      scheduledDate: r.scheduled_date,
      sortOrder: r.sort_order,
      id: r.id,
    })),
    googleItem,
  ])
  assert(JSON.stringify(paginatedMerged) === JSON.stringify(singleFetchMerged))
  // Specifically: the Google item (sortOrder 0) sorts before every real
  // todo here (sort_order 1-6), proving it landed in the SAME page as
  // every same-date real todo rather than being deferred, duplicated, or
  // reordered relative to them.
  assert(paginatedMerged[0].id === 'g-11-30')
})

Deno.test('bd12: MAX_PAGE_EXTENSION safety valve terminates for a pathological same-date volume', () => {
  const hugeSameDate = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => ({ scheduled_date: '2026-08-05', sort_order: i, id: `id-${i}` }),
    )
  let effectiveLimit = 2
  let iterations = 0
  while (true) {
    iterations++
    assert(iterations < 100) // guards the test itself against a real infinite loop
    const data = hugeSameDate(effectiveLimit + 1) // every peeked row still shares the date
    if (!pageSplitsADate(data, effectiveLimit)) break
    const nextLimit = Math.min(effectiveLimit * 2, 500)
    if (nextLimit === effectiveLimit) break
    effectiveLimit = nextLimit
  }
  assert(effectiveLimit === 500)
})

Deno.test('bd12: the cursor after extension is derived from the actual extended last row, not the original limit boundary', () => {
  // 6 rows on 08-05 (forces extension past limit=2), 2 more on 08-06 (still
  // inside the extended page once it reaches 8), 2 more on 08-07 (belong to
  // page 2) -- enough real overflow data that the loop's "no overflow row"
  // exit can't fire just from running out of rows to peek.
  const realRows = [
    { scheduled_date: '2026-08-05', sort_order: 1, id: 'r1' },
    { scheduled_date: '2026-08-05', sort_order: 2, id: 'r2' },
    { scheduled_date: '2026-08-05', sort_order: 3, id: 'r3' },
    { scheduled_date: '2026-08-05', sort_order: 4, id: 'r4' },
    { scheduled_date: '2026-08-05', sort_order: 5, id: 'r5' },
    { scheduled_date: '2026-08-05', sort_order: 6, id: 'r6' },
    { scheduled_date: '2026-08-06', sort_order: 0, id: 'r7' },
    { scheduled_date: '2026-08-06', sort_order: 1, id: 'r8' },
    { scheduled_date: '2026-08-07', sort_order: 0, id: 'r9' },
    { scheduled_date: '2026-08-07', sort_order: 1, id: 'r10' },
  ]
  let effectiveLimit = 2
  let data: typeof realRows = []
  while (true) {
    data = realRows.slice(0, effectiveLimit + 1)
    if (!pageSplitsADate(data, effectiveLimit)) break
    effectiveLimit *= 2
  }
  const items = data.slice(0, effectiveLimit)
  const lastItem = items.at(-1)!

  // Extension (2 -> 4 -> 8) lands with 08-06 (r7, r8) also fully inside this
  // page -- the cursor must be built from THIS actual last row (r8), not
  // the original limit=2 boundary (r2) or even the first split date's last
  // row (r6), or rows already returned would repeat on the next page.
  assert(effectiveLimit === 8)
  assert(lastItem.id === 'r8')
  assert(items.map((i) => i.id).join(',') === 'r1,r2,r3,r4,r5,r6,r7,r8')

  // Simulate "page 2" resuming from a cursor built off this last row: every
  // row strictly after (scheduled_date, sort_order) in sort order.
  const page2 = realRows.filter((r) =>
    r.scheduled_date > lastItem.scheduled_date ||
    (r.scheduled_date === lastItem.scheduled_date && r.sort_order > lastItem.sort_order)
  )
  assert(!page2.some((r) => items.some((i) => i.id === r.id))) // no repeats from page 1
  assert(page2.map((r) => r.id).join(',') === 'r9,r10')
})

Deno.test('googleMirrorEventsInRange maps a mirror row into the shared list-item shape', async () => {
  const items = await googleMirrorEventsInRange(
    fakeSupabase({
      google_calendar_mirror_events: [{
        id: 'evt-1',
        connection_id: 'conn-1',
        title: '팀 스탠드업',
        is_all_day: false,
        start_at: '2026-08-16T09:00:00.000Z',
        end_at: '2026-08-16T09:15:00.000Z',
        location_name: null,
      }],
    }),
    '2026-08-16',
    '2026-08-16',
  )
  assert(items.length === 1)
  assert(items[0].scheduledDate === '2026-08-16')
  assert(items[0].calendarId === 'conn-1')
  assert(items[0].source === 'google_calendar')
  assert(items[0].isVirtual === false)
})

Deno.test('googleMirrorEventsInRange derives scheduledDate in KST, not raw UTC', async () => {
  // 2026-08-15T20:00:00Z is 2026-08-16 05:00 KST -- a naive UTC slice
  // reports the previous day (be7).
  const items = await googleMirrorEventsInRange(
    fakeSupabase({
      google_calendar_mirror_events: [{
        id: 'evt-early',
        connection_id: 'conn-1',
        title: '새벽 러닝',
        is_all_day: false,
        start_at: '2026-08-15T20:00:00.000Z',
        end_at: '2026-08-15T20:30:00.000Z',
        location_name: null,
      }],
    }),
    '2026-08-16',
    '2026-08-16',
  )
  assert(items.length === 1)
  assert(items[0].scheduledDate === '2026-08-16')
})
