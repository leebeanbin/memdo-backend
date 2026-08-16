import { z } from 'zod'

export const agentKeySaveSchema = z.object({
  apiKey: z.string().trim().min(20).max(200),
})

export const OPENROUTER_PROVIDER = 'openrouter'
