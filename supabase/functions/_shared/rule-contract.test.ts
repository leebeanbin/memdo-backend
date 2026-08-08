import { expandOccurrences, localInstant, scheduleRuleInputSchema } from './rule-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('daily rule respects interval and window', () => {
  const dates = expandOccurrences(
    { frequency: 'daily', interval: 2, anchorDate: '2026-08-01' },
    '2026-08-01',
    '2026-08-07',
  )
  assert(
    JSON.stringify(dates) ===
      JSON.stringify(['2026-08-01', '2026-08-03', '2026-08-05', '2026-08-07']),
  )
})

Deno.test('weekdays rule skips weekends', () => {
  // 2026-08-01 is a Saturday; first weekday is Monday 2026-08-03.
  const dates = expandOccurrences(
    { frequency: 'weekdays', interval: 1, anchorDate: '2026-08-01' },
    '2026-08-01',
    '2026-08-09',
  )
  assert(
    JSON.stringify(dates) ===
      JSON.stringify(['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']),
  )
})

Deno.test('monthly rule clamps to the last day of shorter months', () => {
  const dates = expandOccurrences(
    { frequency: 'monthly', interval: 1, anchorDate: '2026-01-31', count: 4 },
    '2026-01-01',
    '2026-12-31',
  )
  assert(
    JSON.stringify(dates) ===
      JSON.stringify(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']),
  )
})

Deno.test('count bounds the whole series even before the window', () => {
  const dates = expandOccurrences(
    { frequency: 'daily', interval: 1, anchorDate: '2026-08-01', count: 3 },
    '2026-08-02',
    '2026-08-31',
  )
  // Series is Aug 1,2,3; window starts Aug 2 → only 2,3 returned.
  assert(JSON.stringify(dates) === JSON.stringify(['2026-08-02', '2026-08-03']))
})

Deno.test('untilDate stops the series', () => {
  const dates = expandOccurrences(
    { frequency: 'weekly', interval: 1, anchorDate: '2026-08-03', untilDate: '2026-08-20' },
    '2026-08-01',
    '2026-12-31',
  )
  assert(JSON.stringify(dates) === JSON.stringify(['2026-08-03', '2026-08-10', '2026-08-17']))
})

Deno.test('local time converts to a UTC instant using the offset', () => {
  // 09:00 at +540 (KST) => 00:00Z
  assert(localInstant('2026-08-03', '09:00', 540) === '2026-08-03T00:00:00.000Z')
})

Deno.test('rule input rejects an event without times', () => {
  const base = {
    calendarId: '00000000-0000-4000-8000-000000000001',
    title: '스탠드업',
    entryKind: 'event',
    timeBucket: 'morning',
    frequency: 'weekdays',
    anchorDate: '2026-08-03',
    timezoneOffsetMinutes: 540,
  }
  assert(!scheduleRuleInputSchema.safeParse(base).success)
  assert(
    scheduleRuleInputSchema.safeParse({ ...base, startTime: '09:00', endTime: '09:15' }).success,
  )
})
