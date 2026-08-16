import { z } from 'zod'

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
// Verified live against https://openrouter.ai/api/v1/models on 2026-08-16 --
// gpt-4o-mini/claude-3.5-sonnet/gemini-2.0-flash (this list's previous
// values) no longer appear in that response at all. Re-check periodically;
// OpenRouter's catalog turns over fast and a stale id here just 400s.
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.4-mini'
export const MAX_TOOL_ITERATIONS = 5

// Curated rather than free-text: OpenRouter proxies hundreds of models, most
// unsuited to fast structured tool-calling for a chat assistant. Keeping
// this list here (not just in the iOS picker) means the server also rejects
// a tampered/unexpected model id instead of forwarding it to OpenRouter.
export const ALLOWED_OPENROUTER_MODELS = [
  'openai/gpt-5.4-mini',
  'openai/gpt-5.6-sol',
  'anthropic/claude-sonnet-5',
  'google/gemini-3.5-flash',
] as const

// A rolling-hour cap per user -- BYOK means a runaway loop or bug burns the
// *user's own* balance, not this backend's, but that's still worth guarding
// against by default rather than assuming good behavior.
export const RATE_LIMIT_PER_HOUR = 30

export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  // Client-managed history (this endpoint is stateless, matching every other
  // function in this backend) -- capped well below any model's context
  // window since a runaway client bug shouldn't turn into an expensive call.
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(40).default([]),
  model: z.enum(ALLOWED_OPENROUTER_MODELS).nullable().optional(),
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

// ── Pure date/time helpers (no DB, no fetch -- unit-testable in isolation) ──
//
// All local-calendar-day/HH:mm math here goes through Date.UTC() plus an
// explicit offset rather than JS's local-timezone Date methods (setHours,
// getHours, etc.) -- those follow the *host process's* timezone, which is
// nondeterministic across dev machines vs. wherever this edge function
// actually runs. DEFAULT_TIMEZONE_OFFSET_MINUTES matches users.timezone's
// default ('Asia/Seoul') and schedule_rules.timezone_offset_minutes's
// default (540) elsewhere in this schema; this endpoint doesn't yet look up
// the requesting user's actual row, so it's a reasonable default rather than
// truly per-user -- worth revisiting if this app gets users outside KST.
export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 540

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function localDateParts(
  reference: Date,
  offsetMinutes: number,
): { y: number; m: number; d: number } {
  const shifted = new Date(reference.getTime() + offsetMinutes * 60_000)
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() }
}

/** Resolves a single proposed/queried date token relative to `today`. */
export function resolveDate(
  token: string,
  today: Date = new Date(),
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
): string {
  const { y, m, d } = localDateParts(today, offsetMinutes)
  if (token === 'today') return toISODate(new Date(Date.UTC(y, m, d)))
  if (token === 'tomorrow') return toISODate(new Date(Date.UTC(y, m, d + 1)))
  return token
}

export function expandScope(
  scope: string,
  today: Date = new Date(),
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
): string[] {
  const { y, m, d } = localDateParts(today, offsetMinutes)
  if (scope === 'today') return [toISODate(new Date(Date.UTC(y, m, d)))]
  if (scope === 'tomorrow') return [toISODate(new Date(Date.UTC(y, m, d + 1)))]
  if (scope === 'this_week') {
    return Array.from({ length: 7 }, (_, i) => toISODate(new Date(Date.UTC(y, m, d + i))))
  }
  return [scope]
}

/** `dateStr` is a local calendar day (yyyy-MM-dd); returns the UTC instant
 * for `hhmm` on that day in the given offset -- same construction as
 * rule-contract.ts's localInstant(), just returning a Date instead of an
 * ISO string since callers here need it for arithmetic/comparison. */
export function timeOn(
  dateStr: string,
  hhmm: string | null | undefined,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
): Date | null {
  if (!hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  const [year, month, date] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date, h, m) - offsetMinutes * 60_000)
}

export function formatSlot(
  start: Date,
  end: Date,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
): string {
  const fmt = (d: Date) => {
    const shifted = new Date(d.getTime() + offsetMinutes * 60_000)
    return `${shifted.getUTCHours()}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
  }
  return `${fmt(start)}-${fmt(end)}`
}

export type ExistingScheduleRow = {
  title: string
  scheduled_date: string
  start_at: string | null
  end_at: string | null
}

export type ProposedScheduleArgs = {
  title: string
  date: string
  startTime?: string | null
  endTime?: string | null
  isTask: boolean
}

/** Resolves a proposal's (start, end), or null for a task/all-day item with
 * nothing to conflict-check against -- mirrors ProposedScheduleDraft.
 * resolvedInterval() on the iOS side so both paths agree on what "conflicts"
 * means. */
export function resolveProposedInterval(
  proposed: ProposedScheduleArgs,
  today: Date = new Date(),
): { start: Date; end: Date } | null {
  if (proposed.isTask || !proposed.startTime) return null
  const date = resolveDate(proposed.date, today)
  const start = timeOn(date, proposed.startTime)
  if (!start) return null
  const end = timeOn(date, proposed.endTime) ?? new Date(start.getTime() + 3_600_000)
  return { start, end }
}

/** The server-side half of Reflection for propose_schedule: guaranteed to
 * run regardless of whether the model chose to call search_schedules first
 * (the system prompt asks it to, but nothing enforces that). Returns the
 * title of the first conflicting existing item, or null. */
export function findConflict(
  existing: ExistingScheduleRow[],
  proposed: ProposedScheduleArgs,
  today: Date = new Date(),
): string | null {
  const interval = resolveProposedInterval(proposed, today)
  if (!interval) return null
  for (const row of existing) {
    if (!row.start_at || !row.end_at) continue
    const rowStart = new Date(row.start_at)
    const rowEnd = new Date(row.end_at)
    if (interval.start < rowEnd && interval.end > rowStart) return row.title
  }
  return null
}

// ── SSE stream parsing/accumulation (pure -- the actual fetch/reader loop
// lives in index.ts, this is just the part worth unit-testing in isolation)
//
// OpenRouter proxies OpenAI's streaming format regardless of the underlying
// model: content and tool_calls never appear in the same turn, and
// tool_calls arrive as index-keyed deltas (id/name/arguments arrive
// separately and must be concatenated) rather than one complete object.

export type StreamToolCallDelta = {
  index: number
  id?: string
  name?: string
  argumentsChunk?: string
}

export type StreamChunk = {
  content?: string
  toolCalls?: StreamToolCallDelta[]
  finishReason?: string | null
}

/** Parses one raw SSE line ("data: {...}") into a normalized chunk. Returns
 * null for the "[DONE]" terminator, blank lines, or anything with no
 * delta worth acting on. */
export function parseStreamLine(rawLine: string): StreamChunk | null {
  const trimmed = rawLine.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return null

  let parsed: any
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  const delta = parsed?.choices?.[0]?.delta
  if (!delta) return null

  const chunk: StreamChunk = {}
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    chunk.content = delta.content
  }
  if (Array.isArray(delta.tool_calls)) {
    chunk.toolCalls = delta.tool_calls.map((tc: any) => ({
      index: tc.index ?? 0,
      id: tc.id,
      name: tc.function?.name,
      argumentsChunk: tc.function?.arguments,
    }))
  }
  const finishReason = parsed.choices?.[0]?.finish_reason
  if (finishReason) chunk.finishReason = finishReason
  return chunk
}

export type AccumulatedToolCall = { id: string; name: string; arguments: string }

export type StreamAccumulator = {
  content: string
  toolCalls: Map<number, AccumulatedToolCall>
}

export function newStreamAccumulator(): StreamAccumulator {
  return { content: '', toolCalls: new Map() }
}

export function applyStreamChunk(acc: StreamAccumulator, chunk: StreamChunk): void {
  if (chunk.content) acc.content += chunk.content
  for (const delta of chunk.toolCalls ?? []) {
    const existing = acc.toolCalls.get(delta.index) ?? { id: '', name: '', arguments: '' }
    if (delta.id) existing.id = delta.id
    if (delta.name) existing.name = delta.name
    if (delta.argumentsChunk) existing.arguments += delta.argumentsChunk
    acc.toolCalls.set(delta.index, existing)
  }
}

/** Reconstructs the tool_calls array shape the OpenAI/OpenRouter messages
 * format expects, so the accumulated turn can be pushed back into the
 * conversation the same way a non-streamed response's `choice` would be. */
export function accumulatedToolCallsArray(
  acc: StreamAccumulator,
): Array<{ id: string; function: { name: string; arguments: string } }> {
  return Array.from(acc.toolCalls.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({ id: tc.id, function: { name: tc.name, arguments: tc.arguments } }))
}
