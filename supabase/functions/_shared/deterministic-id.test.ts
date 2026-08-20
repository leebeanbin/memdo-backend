import { stableUuid } from './deterministic-id.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

Deno.test('stableUuid is deterministic for the same input', async () => {
  const first = await stableUuid('rule-1:2026-08-19')
  const second = await stableUuid('rule-1:2026-08-19')
  assert(first === second)
})

Deno.test('stableUuid differs for different input', async () => {
  const first = await stableUuid('rule-1:2026-08-19')
  const second = await stableUuid('rule-1:2026-08-20')
  assert(first !== second)
})

Deno.test('stableUuid produces a valid v4-shaped UUID', async () => {
  const id = await stableUuid('user-1:daily-summary')
  assert(uuidPattern.test(id))
})
