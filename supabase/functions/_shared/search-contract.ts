import { z } from 'zod'

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(50).default(20),
})

export type SearchQuery = z.infer<typeof searchQuerySchema>
