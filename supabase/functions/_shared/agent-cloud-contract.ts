import { z } from 'zod'

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini'
export const MAX_TOOL_ITERATIONS = 5

export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  // Client-managed history (this endpoint is stateless, matching every other
  // function in this backend) -- capped well below any model's context
  // window since a runaway client bug shouldn't turn into an expensive call.
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(40).default([]),
})

export type CloudAgentTurn = z.infer<typeof chatRequestSchema>['history'][number]

// OpenAI-compatible function-calling schema (OpenRouter proxies this format
// regardless of the underlying model). Mirrors the on-device tool set
// (ProposeScheduleTool/FindFreeSlotTool in AssistantView.swift) plus
// search_schedules, which only makes sense server-side where a DB query is
// cheap -- this is the "open-ended, needs external data" half of the split
// described in the on-device/cloud research (search vs. fixed-shape
// proposals), not a fallback for old devices only.
export const cloudAgentTools = [
  {
    type: 'function',
    function: {
      name: 'search_schedules',
      description:
        "Search the user's schedule within a date range. Use this before answering questions about what's planned, or before proposing something to avoid a duplicate.",
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Start date, yyyy-MM-dd' },
          to: { type: 'string', description: 'End date (inclusive), yyyy-MM-dd' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_free_slots',
      description: "Find open time blocks in the user's calendar.",
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description: "'today', 'tomorrow', 'this_week', or a specific yyyy-MM-dd",
          },
          durationMinutes: { type: 'integer', description: 'Required free-slot length in minutes' },
          windowStart: {
            type: 'string',
            description: 'Earliest start HH:mm, omit for no preference',
          },
          windowEnd: { type: 'string', description: 'Latest end HH:mm, omit for no preference' },
        },
        required: ['scope', 'durationMinutes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_schedule',
      description:
        'Propose a new schedule or task for the user to confirm. This does NOT save anything -- it only stages a proposal the user must explicitly approve. Never claim something was created without the user approving a proposal.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: { type: 'string', description: "'today', 'tomorrow', or yyyy-MM-dd" },
          startTime: { type: 'string', description: 'HH:mm, omit for a task' },
          endTime: { type: 'string', description: 'HH:mm, omit for a task' },
          isTask: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['title', 'date', 'isTask'],
      },
    },
  },
]

export function systemPrompt(today: string): string {
  return [
    "The person's locale is ko_KR. You MUST respond in Korean.",
    "You are Memdo's personal schedule assistant. Be concise, warm, and practical.",
    `Today's date is ${today}.`,
    'When the user wants to create, add, or make a new schedule or task, call propose_schedule -- do not just describe it in text, and do not claim you created it.',
    'When the user asks to find free time or where to fit something, call find_free_slots.',
    'When the user asks about existing plans, or before proposing something new, call search_schedules to check first rather than guessing.',
    'You cannot edit, delete, or directly modify existing schedules -- only propose new ones.',
  ].join('\n')
}
