import { buildDemoRows } from './demo-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('demo rows are stable and relative to the requested local day', async () => {
  const input = {
    userId: '00000000-0000-4000-8000-000000000001',
    localDate: '2026-08-03',
    timezoneOffsetMinutes: 540,
    personalCalendarId: '00000000-0000-4000-8000-000000000002',
    workCalendarId: '00000000-0000-4000-8000-000000000003',
  }
  const first = await buildDemoRows(input)
  const second = await buildDemoRows(input)

  assert(JSON.stringify(first) === JSON.stringify(second))
  assert(first.length === 6)
  assert(first[0].scheduled_date === '2026-08-02')
  assert(first[1].start_at === '2026-08-03T01:00:00.000Z')
  assert(first[5].scheduled_date === '2026-08-04')
  assert(/^[0-9a-f-]{36}$/.test(String(first[0].id)))
})
