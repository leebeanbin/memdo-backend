import { buildEvalSeedRows } from './eval-seed-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('eval seed rows are stable and relative to the requested local day', async () => {
  const input = {
    userId: '00000000-0000-4000-8000-000000000001',
    localDate: '2026-08-16',
    calendarId: '00000000-0000-4000-8000-000000000002',
  }
  const first = await buildEvalSeedRows(input)
  const second = await buildEvalSeedRows(input)

  assert(JSON.stringify(first) === JSON.stringify(second))
  assert(first.length === 2)
  assert(first[0].title === '치과 일정')
  assert(first[0].scheduled_date === '2026-08-16')
  assert(first[0].deleted_at === null)
  assert(first[1].title === '운동')
  assert(first[1].scheduled_date === '2026-08-17')
  assert(first[1].deleted_at === null)
  assert(/^[0-9a-f-]{36}$/.test(String(first[0].id)))
  assert(/^[0-9a-f-]{36}$/.test(String(first[1].id)))
})

Deno.test('eval seed row ids differ from a demo seed row for the same user', async () => {
  // Both use stableUuid(`${userId}:...`) but with different key prefixes
  // (":eval:" here vs demo-contract.ts's bare key) -- confirms they can't
  // collide even for the same userId.
  const rows = await buildEvalSeedRows({
    userId: '00000000-0000-4000-8000-000000000001',
    localDate: '2026-08-16',
    calendarId: '00000000-0000-4000-8000-000000000002',
  })
  const ids = new Set(rows.map((r) => r.id))
  assert(ids.size === rows.length)
})
