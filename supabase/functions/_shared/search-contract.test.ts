import { searchQuerySchema } from './search-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('search query trims and defaults the limit', () => {
  const parsed = searchQuerySchema.parse({ q: '  회의  ' })
  assert(parsed.q === '회의')
  assert(parsed.limit === 20)
})

Deno.test('search query rejects an empty term', () => {
  assert(!searchQuerySchema.safeParse({ q: '   ' }).success)
})

Deno.test('search query clamps the limit range', () => {
  assert(!searchQuerySchema.safeParse({ q: '회의', limit: 0 }).success)
  assert(!searchQuerySchema.safeParse({ q: '회의', limit: 51 }).success)
  assert(searchQuerySchema.parse({ q: '회의', limit: 50 }).limit === 50)
})
