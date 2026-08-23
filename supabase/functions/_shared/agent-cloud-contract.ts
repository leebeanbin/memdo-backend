import { z } from 'zod'
import { AGENT_TOOL_NAMES, parseAgentToolCall } from './agent-tool-contract.ts'
import { type ConflictCandidate, findConflict as findIntervalConflict } from './conflict-service.ts'
import { freeSlotsInWindow } from './free-slot-service.ts'
import { preferencesDto } from './preferences-contract.ts'

export { AGENT_TOOL_NAMES }

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
// Verified live against https://openrouter.ai/api/v1/models on 2026-08-20 --
// all four pre-existing ids still resolve. Re-check periodically; OpenRouter's
// catalog turns over fast and a stale id here just 400s.
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.4-mini'
export const MAX_TOOL_ITERATIONS = 5

// Curated rather than free-text: OpenRouter proxies hundreds of models, most
// unsuited to fast structured tool-calling for a chat assistant. This is the
// single source of truth for what's allowed -- agent-models-contract.ts's
// catalog listing (model picker + live pricing) filters against this exact
// array too, so there's no separate iOS-side list to keep in sync; adding an
// id here makes it selectable and priced automatically.
export const ALLOWED_OPENROUTER_MODELS = [
  'openai/gpt-5.4-mini',
  'openai/gpt-5.6-sol',
  'anthropic/claude-sonnet-5',
  'google/gemini-3.5-flash',
  // Cheapest tool-capable model on OpenRouter as of 2026-08-20 (prompt
  // $0.03/M, completion $0.13/M, 1M context) -- roughly 10-30x cheaper than
  // the rest of this list, for BYOK users who want a low-cost default.
  'qwen/qwen3.7-flash',
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
// regardless of the underlying model). search_schedules/find_free_slots/
// propose_schedule/propose_schedule_update mirror the on-device tool set
// (ProposeScheduleTool/FindFreeSlotTool/UpdateScheduleTool in
// AssistantView.swift) where a DB query is cheap server-side -- this is the
// "open-ended, needs external data" half of the split described in the
// on-device/cloud research (search vs. fixed-shape proposals), not a
// fallback for old devices only. get_day_context/get_routine_preferences/
// get_review_history/propose_routine_update/propose_review_actions are
// currently cloud-only with no on-device tool AND no confirmation-card UI
// yet for the two propose_* ones (see ToolDispatchState's doc comment) --
// added ahead of both so the plumbing is ready once either lands.
export const cloudAgentTools = [
  {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAMES.searchSchedules,
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
      name: AGENT_TOOL_NAMES.findFreeSlots,
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
      name: AGENT_TOOL_NAMES.proposeSchedule,
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
  {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAMES.proposeScheduleUpdate,
      description:
        'Propose completing, moving, or deleting an EXISTING schedule or task. This does NOT change anything -- it only stages a proposal the user must explicitly approve. You must have a real `id` from a prior search_schedules call; never invent one or guess. Never claim an item was completed, moved, or deleted without the user approving a proposal.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: "The item's id, from a prior search_schedules result",
          },
          action: {
            type: 'string',
            enum: ['complete', 'reschedule', 'delete'],
            description: "'complete' marks it done, 'reschedule' moves it, 'delete' removes it",
          },
          date: {
            type: 'string',
            description: "For 'reschedule' only: 'today', 'tomorrow', or yyyy-MM-dd",
          },
          startTime: { type: 'string', description: "For 'reschedule' only: HH:mm" },
          endTime: { type: 'string', description: "For 'reschedule' only: HH:mm" },
        },
        required: ['id', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAMES.getDayContext,
      description:
        "Gets a breakdown of a single day's items (completed vs. incomplete, with titles), plus whether a daily reflection already exists for that day. Use this instead of search_schedules when the user is asking about how a specific day went, not just what's on it.",
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: "'today', 'tomorrow', 'yesterday', or yyyy-MM-dd. Omit for today.",
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAMES.getRoutinePreferences,
      description:
        "Gets the user's routine settings: daily review time/days, news briefing time/days, planning prompt time, and whether notifications are on. Use this before discussing or proposing a change to any of these.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAMES.getReviewHistory,
      description:
        'Gets the most recent daily reflections the user has written, most recent first. Use this when the user asks about patterns across past reviews.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max reflections to return, default 10, max 30' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAMES.proposeRoutineUpdate,
      description:
        'Proposes a change to one or more routine settings for the user to confirm. This does NOT change anything -- it only stages a proposal. Only include the fields that should change; omit the rest. Never claim a setting was changed without the user approving a proposal.',
      parameters: {
        type: 'object',
        properties: {
          dailyReviewEnabled: { type: 'boolean' },
          dailyReviewTime: { type: 'string', description: 'HH:mm' },
          newsBriefingEnabled: { type: 'boolean' },
          newsBriefingTime: { type: 'string', description: 'HH:mm' },
          planningPromptTime: { type: 'string', description: 'HH:mm' },
          notificationsEnabled: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAMES.proposeReviewActions,
      description:
        "Proposes writing or updating a specific day's reflection text, based on the conversation. This does NOT save anything -- it only stages a proposal the user must explicitly approve. Never claim a reflection was saved without the user approving a proposal.",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: "'today', 'yesterday', or yyyy-MM-dd" },
          reflection: { type: 'string', description: 'The proposed reflection text, in Korean' },
        },
        required: ['date', 'reflection'],
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
    'When the user wants to complete, move, or delete an EXISTING schedule or task, first call search_schedules to find its real id, then call propose_schedule_update -- do not guess an id, and do not claim the change happened.',
    'When the user asks how a specific day went (not just what was on it), call get_day_context instead of search_schedules.',
    'When the user asks about or wants to change routine settings (daily review, news briefing, planning prompt, notifications), call get_routine_preferences first, then propose_routine_update if they want a change.',
    'When the user asks about patterns across past reflections, call get_review_history.',
    'When the user wants to write or update a reflection for a specific day, call propose_review_actions -- do not just describe it in text.',
    "You cannot directly modify, complete, move, or delete anything -- every change goes through a propose_* tool and needs the user's explicit approval.",
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

/** Resolves a single proposed/queried date token relative to `today`.
 * 'yesterday' exists for propose_review_actions (reflections are naturally
 * about a day that's already over); the schedule-facing tools
 * (propose_schedule, find_free_slots, ...) only ever need today/tomorrow/
 * an explicit date, so this doesn't affect them. */
export function resolveDate(
  token: string,
  today: Date = new Date(),
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
): string {
  const { y, m, d } = localDateParts(today, offsetMinutes)
  if (token === 'today') return toISODate(new Date(Date.UTC(y, m, d)))
  if (token === 'tomorrow') return toISODate(new Date(Date.UTC(y, m, d + 1)))
  if (token === 'yesterday') return toISODate(new Date(Date.UTC(y, m, d - 1)))
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
  id: string
  title: string
  scheduled_date: string
  start_at: string | null
  end_at: string | null
  version: number
}

export type ProposedScheduleArgs = {
  title: string
  date: string
  startTime?: string | null
  endTime?: string | null
  isTask: boolean
}

export type ProposedScheduleUpdateArgs = {
  id: string
  action: 'complete' | 'reschedule' | 'delete'
  date?: string | null
  startTime?: string | null
  endTime?: string | null
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

function toConflictCandidates(rows: ExistingScheduleRow[]): ConflictCandidate[] {
  return rows
    .filter((row) => row.start_at && row.end_at)
    .map((row) => ({
      id: row.id,
      title: row.title,
      start: new Date(row.start_at!),
      end: new Date(row.end_at!),
    }))
}

/** The server-side half of Reflection for propose_schedule: guaranteed to
 * run regardless of whether the model chose to call search_schedules first
 * (the system prompt asks it to, but nothing enforces that). Returns the
 * title of the first conflicting existing item, or null.
 *
 * Resolving `proposed` into a TimeRange (date/time token resolution) stays
 * here rather than moving into conflict-service.ts -- that would need
 * resolveDate/timeOn, which are defined in this file, creating a circular
 * import. Only the pure interval-overlap check is delegated. */
export function findConflict(
  existing: ExistingScheduleRow[],
  proposed: ProposedScheduleArgs,
  today: Date = new Date(),
): string | null {
  const interval = resolveProposedInterval(proposed, today)
  if (!interval) return null
  const conflict = findIntervalConflict(interval, toConflictCandidates(existing))
  return conflict?.title ?? null
}

// ── DB-backed tool implementations + dispatch (moved out of index.ts so the
// dispatch logic -- including both propose_* Reflection blocks -- is
// unit-testable against a fake `supabase` port instead of only reachable
// through a live HTTP call) ──

type SupabasePort = { from: (table: string) => any }

async function fetchSchedules(
  supabase: SupabasePort,
  from: string,
  to: string,
): Promise<ExistingScheduleRow[]> {
  const { data, error } = await supabase
    .from('todos')
    .select('id,title,scheduled_date,start_at,end_at,version')
    .is('deleted_at', null)
    .gte('scheduled_date', from)
    .lte('scheduled_date', to)
    .limit(200)
  if (error) throw error
  return data as ExistingScheduleRow[]
}

/** Single-row lookup for propose_schedule_update -- the model only ever
 * has an id from a prior search_schedules result, never a full row, so this
 * is how it (and Reflection's conflict check) learns the item's current
 * title/version. Returns null rather than throwing on a missing/deleted/
 * foreign row so the caller can fail closed with a clear tool result instead
 * of a generic 500. */
async function fetchScheduleById(
  supabase: SupabasePort,
  id: string,
): Promise<ExistingScheduleRow | null> {
  const { data, error } = await supabase
    .from('todos')
    .select('id,title,scheduled_date,start_at,end_at,version')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw error
  return (data as ExistingScheduleRow | null) ?? null
}

async function searchSchedules(
  supabase: SupabasePort,
  args: { from?: string; to?: string },
): Promise<unknown> {
  if (!args.from || !args.to) return { error: 'from and to are required' }
  try {
    const rows = await fetchSchedules(supabase, args.from, args.to)
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        scheduledDate: r.scheduled_date,
        startAt: r.start_at,
        endAt: r.end_at,
      })),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function findFreeSlots(
  supabase: SupabasePort,
  args: { scope?: string; durationMinutes?: number; windowStart?: string; windowEnd?: string },
): Promise<unknown> {
  const dates = expandScope(args.scope ?? 'today')
  const duration = Math.max(15, args.durationMinutes ?? 30) * 60_000
  const from = dates[0]
  const to = dates.at(-1) ?? dates[0]

  let rows: ExistingScheduleRow[]
  try {
    rows = await fetchSchedules(supabase, from, to)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const busy = rows.filter((row) => row.start_at && row.end_at)

  const lines: string[] = []
  for (const date of dates) {
    const dayBusy = busy
      .filter((row) => row.scheduled_date === date)
      .map((row) => ({ start: new Date(row.start_at!), end: new Date(row.end_at!) }))

    const windowStart = timeOn(date, args.windowStart) ?? timeOn(date, '08:00')!
    const windowEnd = timeOn(date, args.windowEnd) ?? timeOn(date, '22:00')!

    const candidates = freeSlotsInWindow(dayBusy, windowStart, windowEnd, duration)
    if (candidates.length > 0) {
      lines.push(`${date}: ${candidates.map((c) => formatSlot(c.start, c.end)).join(', ')}`)
    }
  }

  return { slots: lines }
}

type DayItemRow = {
  id: string
  title: string
  start_at: string | null
  end_at: string | null
  status: string
}

async function fetchDayItems(supabase: SupabasePort, date: string): Promise<DayItemRow[]> {
  const { data, error } = await supabase
    .from('todos')
    .select('id,title,start_at,end_at,status')
    .eq('scheduled_date', date)
    .is('deleted_at', null)
    .limit(200)
  if (error) throw error
  return data as DayItemRow[]
}

async function getDayContext(
  supabase: SupabasePort,
  args: { date?: string },
  today: Date,
): Promise<unknown> {
  const date = resolveDate(args.date ?? 'today', today)
  let items: DayItemRow[]
  try {
    items = await fetchDayItems(supabase, date)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const completed = items.filter((row) => row.status === 'completed')
  const incomplete = items.filter((row) => row.status !== 'completed')

  let hasReflection = false
  try {
    const { data, error } = await supabase
      .from('daily_reviews')
      .select('review_date')
      .eq('review_date', date)
      .maybeSingle()
    if (error) throw error
    hasReflection = data != null
  } catch {
    // Reflection presence is a minor, non-blocking part of this tool's
    // answer -- unlike propose_*'s conflict checks, there's nothing this
    // tool commits to that a wrong "false" here would corrupt, so this
    // fails soft rather than failing the whole call.
    hasReflection = false
  }

  return {
    date,
    completedCount: completed.length,
    incompleteCount: incomplete.length,
    completed: completed.map((row) => ({ id: row.id, title: row.title })),
    incomplete: incomplete.map((row) => ({
      id: row.id,
      title: row.title,
      startAt: row.start_at,
      endAt: row.end_at,
    })),
    hasReflection,
  }
}

async function getRoutinePreferences(supabase: SupabasePort): Promise<unknown> {
  const { data, error } = await supabase.from('user_preferences').select('*').maybeSingle()
  if (error) return { error: error instanceof Error ? error.message : String(error) }
  if (!data) return { configured: false }
  return { configured: true, ...preferencesDto(data) }
}

/** Mirrors reviews/index.ts's private reviewDto() -- duplicated rather than
 * imported since that function isn't exported (kept function-local there).
 * Phase 10 (#5 in the responsibility-separation plan) moves reviewDto into
 * its own _shared contract file, at which point both call sites should
 * import the same one instead of each defining their own. */
function reviewHistoryDto(row: Record<string, unknown>) {
  return {
    reviewDate: row.review_date,
    reflection: row.reflection,
  }
}

async function getReviewHistory(
  supabase: SupabasePort,
  args: { limit?: number },
): Promise<unknown> {
  const limit = Math.min(30, Math.max(1, args.limit ?? 10))
  const { data, error } = await supabase
    .from('daily_reviews')
    .select('review_date,reflection')
    .order('review_date', { ascending: false })
    .limit(limit)
  if (error) return { error: error instanceof Error ? error.message : String(error) }
  return { reviews: (data as Record<string, unknown>[]).map(reviewHistoryDto) }
}

/** Accumulates across the whole tool-calling loop (which can span several
 * OpenRouter round trips) so the final `done` message always reflects the
 * latest propose_schedule/propose_schedule_update call, however many
 * iterations it took to get there. */
export type ProposedRoutineUpdateArgs = {
  dailyReviewEnabled?: boolean
  dailyReviewTime?: string
  newsBriefingEnabled?: boolean
  newsBriefingTime?: string
  planningPromptTime?: string
  notificationsEnabled?: boolean
}

export type ProposedReviewActionArgs = {
  date: string
  reflection: string
}

export type ToolDispatchState = {
  proposedSchedule: (ProposedScheduleArgs & { note?: string }) | null
  conflictTitle: string | null
  conflictCheckFailed: boolean
  proposedScheduleUpdate:
    | (ProposedScheduleUpdateArgs & {
      title: string
      version: number
      conflictTitle: string | null
      conflictCheckFailed: boolean
    })
    | null
  // No card renders these two yet (see AssistantView.swift's
  // AgentScheduleUpdateProposal doc comment for the propose_schedule_update
  // precedent this will eventually follow) -- carried through the `done`
  // message regardless, same as the other two, so the plumbing is already
  // correct once a card exists.
  proposedRoutineUpdate: ProposedRoutineUpdateArgs | null
  proposedReviewAction: ProposedReviewActionArgs | null
}

export function newToolDispatchState(): ToolDispatchState {
  return {
    proposedSchedule: null,
    conflictTitle: null,
    conflictCheckFailed: false,
    proposedScheduleUpdate: null,
    proposedRoutineUpdate: null,
    proposedReviewAction: null,
  }
}

/** Shape of the terminal streamed line agent-cloud-chat/index.ts sends --
 * matches iOS's AgentStreamLineDTO (ScheduleAPI.swift) field for field.
 * `proposedSchedule`'s conflict fields get folded in here since
 * ToolDispatchState keeps them alongside rather than nested inside (see
 * that type's doc comment); `proposedScheduleUpdate` already carries its
 * own. Exported so both call sites in index.ts build this from the same
 * function (a field added to ToolDispatchState can't end up wired into one
 * and silently missing from the other) and so the exact key set is
 * unit-testable against iOS's DTOs without a live HTTP call. */
export function buildDonePayload(state: ToolDispatchState): {
  done: true
  proposedSchedule:
    | (ProposedScheduleArgs & {
      note?: string
      conflictTitle: string | null
      conflictCheckFailed: boolean
    })
    | null
  proposedScheduleUpdate: ToolDispatchState['proposedScheduleUpdate']
  proposedRoutineUpdate: ToolDispatchState['proposedRoutineUpdate']
  proposedReviewAction: ToolDispatchState['proposedReviewAction']
} {
  return {
    done: true,
    proposedSchedule: state.proposedSchedule
      ? {
        ...state.proposedSchedule,
        conflictTitle: state.conflictTitle,
        conflictCheckFailed: state.conflictCheckFailed,
      }
      : null,
    proposedScheduleUpdate: state.proposedScheduleUpdate,
    proposedRoutineUpdate: state.proposedRoutineUpdate,
    proposedReviewAction: state.proposedReviewAction,
  }
}

/** Dispatches one accumulated tool call to its implementation, mutating
 * `state` in place for the two propose_* tools (mirroring the shape the
 * streamed `done` message reports) and returning the tool-result payload to
 * push back into the conversation as a `role: 'tool'` message. */
type ToolHandler = (
  supabase: SupabasePort,
  args: any,
  state: ToolDispatchState,
  today: Date,
) => Promise<unknown>

async function handleProposeSchedule(
  supabase: SupabasePort,
  args: any,
  state: ToolDispatchState,
  today: Date,
): Promise<unknown> {
  state.proposedSchedule = args
  // Reflection: guaranteed, not dependent on the model having called
  // search_schedules first (the system prompt asks it to, but nothing
  // enforces that).
  //
  // Fail closed: if the existing-schedule fetch itself fails, we cannot
  // claim "no conflict" -- that would silently defeat the whole point of
  // this check. The try/catch here is load-bearing, not incidental --
  // removing it to minimize try/catch would silently reintroduce a fail-
  // open conflict check. Surface it as its own flag instead of folding it
  // into conflictTitle (a real conflict has a real event title; "we
  // couldn't check" doesn't, and the client renders conflictTitle inside a
  // "there's a '<title>' at the same time" sentence).
  // args.date is required by proposeScheduleArgsSchema (parseAgentToolCall
  // already validated it before this handler ran) -- no fallback needed.
  const proposedDate = resolveDate(args.date, today)
  let existing: ExistingScheduleRow[]
  try {
    existing = await fetchSchedules(supabase, proposedDate, proposedDate)
  } catch {
    existing = []
    state.conflictCheckFailed = true
  }
  state.conflictTitle = state.conflictCheckFailed ? null : findConflict(existing, args, today)
  return state.conflictCheckFailed
    ? {
      ok: false,
      warning:
        'Could not verify existing schedules for conflicts -- tell the user to double-check before saving.',
    }
    : state.conflictTitle
    ? { ok: true, warning: `Conflicts with existing '${state.conflictTitle}'` }
    : { ok: true }
}

async function handleProposeScheduleUpdate(
  supabase: SupabasePort,
  args: any,
  state: ToolDispatchState,
  today: Date,
): Promise<unknown> {
  const updateArgs = args as ProposedScheduleUpdateArgs
  try {
    const target = await fetchScheduleById(supabase, updateArgs.id)
    if (!target) {
      state.proposedScheduleUpdate = null
      return {
        ok: false,
        error:
          'That item was not found -- it may have been deleted, or the id is wrong. Call search_schedules again.',
      }
    }

    // Reflection, same fail-closed shape as propose_schedule: only
    // reschedule has a new time to conflict-check, and the target's own
    // current row must be excluded from that check or it would always
    // "conflict" with itself.
    let updateConflictTitle: string | null = null
    let updateConflictCheckFailed = false
    if (updateArgs.action === 'reschedule') {
      // Required by proposeScheduleUpdateArgsSchema's 'reschedule' variant
      // (parseAgentToolCall already validated this) -- ProposedScheduleUpdateArgs
      // still types `date` as optional since it also covers complete/delete,
      // which never carry one.
      const date = updateArgs.date as string
      const targetDate = resolveDate(date, today)
      try {
        const existing = await fetchSchedules(supabase, targetDate, targetDate)
        updateConflictTitle = findConflict(
          existing.filter((row) => row.id !== updateArgs.id),
          {
            title: target.title,
            date,
            startTime: updateArgs.startTime,
            endTime: updateArgs.endTime,
            isTask: false,
          },
          today,
        )
      } catch {
        updateConflictCheckFailed = true
      }
    }

    state.proposedScheduleUpdate = {
      ...updateArgs,
      title: target.title,
      version: target.version,
      conflictTitle: updateConflictCheckFailed ? null : updateConflictTitle,
      conflictCheckFailed: updateConflictCheckFailed,
    }
    return updateConflictCheckFailed
      ? {
        ok: false,
        warning:
          'Could not verify existing schedules for conflicts -- tell the user to double-check before saving.',
      }
      : updateConflictTitle
      ? { ok: true, warning: `Conflicts with existing '${updateConflictTitle}'` }
      : { ok: true }
  } catch {
    state.proposedScheduleUpdate = null
    return {
      ok: false,
      error: 'Could not look up that item. Tell the user something went wrong.',
    }
  }
}

// One handler per tool, keyed by the same AGENT_TOOL_NAMES constants the
// schema above uses -- a lookup table rather than a switch/if-chain, so
// adding a tool means adding an entry here rather than editing a growing
// branch (Open/Closed: dispatchToolCall itself never changes).
const toolHandlers: Record<string, ToolHandler> = {
  [AGENT_TOOL_NAMES.searchSchedules]: (supabase, args) => searchSchedules(supabase, args),
  [AGENT_TOOL_NAMES.findFreeSlots]: (supabase, args) => findFreeSlots(supabase, args),
  [AGENT_TOOL_NAMES.proposeSchedule]: handleProposeSchedule,
  [AGENT_TOOL_NAMES.proposeScheduleUpdate]: handleProposeScheduleUpdate,
  [AGENT_TOOL_NAMES.getDayContext]: (supabase, args, _state, today) =>
    getDayContext(supabase, args, today),
  [AGENT_TOOL_NAMES.getRoutinePreferences]: (supabase) => getRoutinePreferences(supabase),
  [AGENT_TOOL_NAMES.getReviewHistory]: (supabase, args) => getReviewHistory(supabase, args),
  // Neither propose_* below has anything to conflict-check -- unlike a
  // schedule, one preference value or one reflection doesn't collide with
  // another the way two time-ranges can.
  [AGENT_TOOL_NAMES.proposeRoutineUpdate]: async (_supabase, args, state) => {
    state.proposedRoutineUpdate = args
    return { ok: true }
  },
  [AGENT_TOOL_NAMES.proposeReviewActions]: async (_supabase, args, state) => {
    state.proposedReviewAction = args
    return { ok: true }
  },
}

/** Runs every tool call through parseAgentToolCall's validation boundary
 * before a handler ever executes -- an invalid or unsupported call returns
 * a tool-result error and leaves `state` completely untouched (nothing gets
 * staged) instead of forwarding whatever the model produced. */
export async function dispatchToolCall(
  supabase: SupabasePort,
  toolName: string,
  args: any,
  state: ToolDispatchState,
  today: Date = new Date(),
): Promise<unknown> {
  const parsed = parseAgentToolCall(toolName, args)
  if (!parsed.ok) {
    if (parsed.kind === 'UNSUPPORTED_TOOL') {
      return { error: 'UNSUPPORTED_TOOL' }
    }
    console.error(
      JSON.stringify({
        operation: 'agent_cloud_chat.invalid_argument',
        toolName,
        issues: parsed.issues,
      }),
    )
    return { error: 'INVALID_AGENT_ARGUMENT', issues: parsed.issues }
  }

  const handler = toolHandlers[toolName]
  return await handler(supabase, parsed.args, state, today)
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
  usage?: AgentUsage
}

export type AgentUsage = {
  promptTokens: number
  completionTokens: number
  costUsd: number
}

/** Parses one raw SSE line ("data: {...}") into a normalized chunk. Returns
 * null for the "[DONE]" terminator, blank lines, or anything with no content,
 * tool call, finish reason, or final usage worth acting on. */
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
  const chunk: StreamChunk = {}
  const delta = parsed?.choices?.[0]?.delta
  if (typeof delta?.content === 'string' && delta.content.length > 0) {
    chunk.content = delta.content
  }
  if (Array.isArray(delta?.tool_calls)) {
    chunk.toolCalls = delta.tool_calls.map((tc: any) => ({
      index: tc.index ?? 0,
      id: tc.id,
      name: tc.function?.name,
      argumentsChunk: tc.function?.arguments,
    }))
  }
  const finishReason = parsed.choices?.[0]?.finish_reason
  if (finishReason) chunk.finishReason = finishReason
  const usage = parsed?.usage
  if (
    usage && Number.isFinite(usage.prompt_tokens) &&
    Number.isFinite(usage.completion_tokens) && Number.isFinite(usage.cost)
  ) {
    chunk.usage = {
      promptTokens: Math.max(0, usage.prompt_tokens),
      completionTokens: Math.max(0, usage.completion_tokens),
      costUsd: Math.max(0, usage.cost),
    }
  }
  return chunk.content || chunk.toolCalls || chunk.finishReason || chunk.usage ? chunk : null
}

export type AccumulatedToolCall = { id: string; name: string; arguments: string }

export type StreamAccumulator = {
  content: string
  toolCalls: Map<number, AccumulatedToolCall>
  usage: AgentUsage
}

export function newStreamAccumulator(): StreamAccumulator {
  return {
    content: '',
    toolCalls: new Map(),
    usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
  }
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
  if (chunk.usage) acc.usage = chunk.usage
}

export function addAgentUsage(total: AgentUsage, usage: AgentUsage): void {
  total.promptTokens += usage.promptTokens
  total.completionTokens += usage.completionTokens
  total.costUsd += usage.costUsd
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
