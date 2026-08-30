import {
  expandOccurrences,
  ianaOffsetMinutes,
  localInstant,
  materializeRow,
  scheduleRuleInputSchema,
  virtualOccurrenceDto,
} from './rule-contract.ts'

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

Deno.test('biweekly rule respects interval, not just a hardcoded 14 days (bd15/be15)', () => {
  // interval: 2 on a 'biweekly' rule means every 4 weeks (2 * 14 days) --
  // previously hardcoded to `index * 14`, so this collapsed to plain
  // biweekly (every 2 weeks) regardless of interval.
  const dates = expandOccurrences(
    { frequency: 'biweekly', interval: 2, anchorDate: '2026-08-01' },
    '2026-08-01',
    '2026-09-30',
  )
  assert(JSON.stringify(dates) === JSON.stringify(['2026-08-01', '2026-08-29', '2026-09-26']))
})

Deno.test('biweekly rule with interval 1 is unchanged -- every 14 days', () => {
  const dates = expandOccurrences(
    { frequency: 'biweekly', interval: 1, anchorDate: '2026-08-01' },
    '2026-08-01',
    '2026-09-05',
  )
  assert(JSON.stringify(dates) === JSON.stringify(['2026-08-01', '2026-08-15', '2026-08-29']))
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

Deno.test('ianaOffsetMinutes matches the fixed KST constant for Asia/Seoul', () => {
  assert(ianaOffsetMinutes('Asia/Seoul', new Date('2026-08-16T00:00:00Z')) === 540)
  assert(ianaOffsetMinutes('Asia/Seoul', new Date('2026-01-16T00:00:00Z')) === 540)
})

Deno.test('ianaOffsetMinutes tracks a DST transition, unlike a fixed offset constant', () => {
  // America/Los_Angeles is UTC-8 (PST) in January, UTC-7 (PDT) in August.
  assert(ianaOffsetMinutes('America/Los_Angeles', new Date('2026-01-16T00:00:00Z')) === -480)
  assert(ianaOffsetMinutes('America/Los_Angeles', new Date('2026-08-16T00:00:00Z')) === -420)
})

const laRule = {
  id: 'rule-la',
  calendar_id: 'cal-1',
  title: 'Standup',
  entry_kind: 'event',
  is_all_day: false,
  note: null,
  start_time: '09:00',
  end_time: '09:30',
  time_bucket: 'morning',
  reminder_offset_minutes: null,
  timezone: 'America/Los_Angeles',
}

Deno.test("materializeRow computes each occurrence's own DST-correct offset, not one frozen at rule creation (bd16)", async () => {
  // Same rule, same local wall-clock start time (09:00), one occurrence in
  // January (PST, -480) and one in August (PDT, -420) -- previously
  // schedule_rules stored a single offset captured once at creation and
  // reused it for every future occurrence regardless of season, so one of
  // these two would have come out an hour off.
  const january = await materializeRow(laRule, '2026-01-16', 'user-1')
  const august = await materializeRow(laRule, '2026-08-16', 'user-1')
  assert(january.start_at === '2026-01-16T17:00:00.000Z')
  assert(august.start_at === '2026-08-16T16:00:00.000Z')
})

Deno.test("virtualOccurrenceDto computes each occurrence's own DST-correct offset (bd16)", async () => {
  const january = await virtualOccurrenceDto(laRule, '2026-01-16')
  const august = await virtualOccurrenceDto(laRule, '2026-08-16')
  assert(january.startAt === '2026-01-16T17:00:00.000Z')
  assert(august.startAt === '2026-08-16T16:00:00.000Z')
})

Deno.test('rule input rejects an event without times', () => {
  const base = {
    calendarId: '00000000-0000-4000-8000-000000000001',
    title: '스탠드업',
    entryKind: 'event',
    timeBucket: 'morning',
    frequency: 'weekdays',
    anchorDate: '2026-08-03',
    timezone: 'Asia/Seoul',
  }
  assert(!scheduleRuleInputSchema.safeParse(base).success)
  assert(
    scheduleRuleInputSchema.safeParse({ ...base, startTime: '09:00', endTime: '09:15' }).success,
  )
})
