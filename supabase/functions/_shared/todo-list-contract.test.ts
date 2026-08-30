import { googleMirrorEventsInRange, virtualOccurrencesInRange } from './todo-list-contract.ts'

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
  const result = await virtualOccurrencesInRange(
    fakeSupabase({ schedule_rules: [dailyEventRule], todos: [] }),
    '2026-08-16',
    '2026-08-18',
  )
  assert(result.items.length === 3)
  assert(result.items.every((item: any) => item.title === '아침 스트레칭'))
  assert(result.windowEnd === '2026-08-18')
})

Deno.test('virtualOccurrencesInRange skips a date that already has a materialized row', async () => {
  const result = await virtualOccurrencesInRange(
    fakeSupabase({
      schedule_rules: [dailyEventRule],
      todos: [{ schedule_rule_id: 'rule-1', scheduled_date: '2026-08-17' }],
    }),
    '2026-08-16',
    '2026-08-18',
  )
  assert(result.items.length === 2)
  const dates = result.items.map((item: any) => item.scheduledDate)
  assert(!dates.includes('2026-08-17'))
})

Deno.test('virtualOccurrencesInRange clamps windowEnd to MAX_VIRTUAL_WINDOW_DAYS', async () => {
  const result = await virtualOccurrencesInRange(
    fakeSupabase({ schedule_rules: [], todos: [] }),
    '2026-08-16',
    '2030-08-16', // 4 years out, far past the 366-day clamp
  )
  assert(result.windowEnd === '2027-08-17')
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
