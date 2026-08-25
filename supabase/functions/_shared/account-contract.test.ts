import { accountDeletionRequestSchema } from './account-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('accountDeletionRequestSchema accepts the exact confirmation literal', () => {
  const result = accountDeletionRequestSchema.safeParse({ confirmation: 'DELETE' })
  assert(result.success)
})

Deno.test('accountDeletionRequestSchema rejects a wrong or missing confirmation', () => {
  assert(!accountDeletionRequestSchema.safeParse({ confirmation: 'delete' }).success)
  assert(!accountDeletionRequestSchema.safeParse({ confirmation: 'yes' }).success)
  assert(!accountDeletionRequestSchema.safeParse({}).success)
})
