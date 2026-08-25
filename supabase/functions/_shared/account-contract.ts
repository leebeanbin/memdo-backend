import { z } from 'zod'

// Matches the DELETE /account contract's request body (docs/05-api-spec.yaml)
// -- a typed confirmation string, not just relying on the HTTP method itself,
// as a small extra guard against an accidental/automated DELETE call.
export const accountDeletionRequestSchema = z.object({
  confirmation: z.literal('DELETE'),
})
