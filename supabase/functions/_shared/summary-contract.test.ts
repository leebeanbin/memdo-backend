import { reviewInputSchema, summaryQuerySchema, summaryRange } from './summary-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('today scope covers a single day', () => {
  const range = summaryRange('today', '2026-08-05')
  assert(range.start === '2026-08-05' && range.end === '2026-08-06')
})

Deno.test('week scope is the trailing 7 days before today', () => {
  const range = summaryRange('week', '2026-08-05')
  assert(range.start === '2026-07-29' && range.end === '2026-08-05')
})

Deno.test('month scope is the trailing 30 days before today', () => {
  const range = summaryRange('month', '2026-08-05')
  assert(range.start === '2026-07-06' && range.end === '2026-08-05')
})

Deno.test('summary query validates scope and date', () => {
  assert(summaryQuerySchema.safeParse({ scope: 'week', localDate: '2026-08-05' }).success)
  assert(!summaryQuerySchema.safeParse({ scope: 'year', localDate: '2026-08-05' }).success)
  assert(!summaryQuerySchema.safeParse({ scope: 'today', localDate: 'nope' }).success)
})

Deno.test('review reflection has an upper bound', () => {
  assert(reviewInputSchema.safeParse({ reflection: '잘 마무리했다' }).success)
  assert(reviewInputSchema.safeParse({ reflection: null }).success)
  assert(!reviewInputSchema.safeParse({ reflection: 'x'.repeat(2001) }).success)
})
