import { z } from 'zod'

// Single source of truth for every cloud Agent tool name -- referenced by
// cloudAgentTools' JSON Schema (agent-cloud-contract.ts, what the model
// sees) and by agentArgsSchemaByTool below (what's actually enforced).
// Re-exported from agent-cloud-contract.ts for existing callers.
export const AGENT_TOOL_NAMES = {
  searchSchedules: 'search_schedules',
  findFreeSlots: 'find_free_slots',
  proposeSchedule: 'propose_schedule',
  proposeScheduleUpdate: 'propose_schedule_update',
  getDayContext: 'get_day_context',
  getRoutinePreferences: 'get_routine_preferences',
  getReviewHistory: 'get_review_history',
  proposeRoutineUpdate: 'propose_routine_update',
  proposeReviewActions: 'propose_review_actions',
  requestClarification: 'request_clarification',
} as const

// ── Argument validation boundary ────────────────────────────────────────
//
// What this file is NOT: an "AgentIntent" that interprets what the user
// meant. The model has already chosen a tool by the time anything here
// runs -- this only checks whether the arguments it produced for that
// choice satisfy the contract, before dispatchToolCall's handler (in
// agent-cloud-contract.ts) ever executes. Naming it parseAgentIntent would
// suggest it does semantic intent classification, which belongs to Epic
// E's eval work, not this boundary.
//
// cloudAgentTools' JSON Schema (agent-cloud-contract.ts) and the Zod
// schemas below now both describe constraints on the same 9 tools'
// arguments -- that overlap is allowed to exist for now, but the two are
// NOT equivalent and must not be assumed to drift together automatically:
// cloudAgentTools' JSON Schema is model guidance only (what OpenRouter
// shows the model to shape its output) and is never itself enforced;
// these Zod schemas are the actual source of truth/enforcement point, run
// against whatever the model actually returned. When later work touches
// either side, check the other for drift explicitly -- there is no shared
// definition backing both today.

export const dateExpressionSchema = z.enum(['today', 'tomorrow']).or(z.iso.date())
export const dateExpressionWithYesterdaySchema = z.enum(['today', 'tomorrow', 'yesterday']).or(
  z.iso.date(),
)
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const proposeScheduleArgsSchema = z.object({
  // bd4: was max(200) -- todoInputSchema (the real save-time limit) caps at
  // 120, so a 121-200 char title staged fine and then failed to save on
  // approval. Matched to the real limit so a staged proposal can never
  // fail this specific check that a save would also fail.
  title: z.string().trim().min(1).max(120),
  date: dateExpressionSchema,
  startTime: timeSchema.optional(),
  endTime: timeSchema.optional(),
  isTask: z.boolean(),
  note: z.string().max(2000).optional(),
}).superRefine((value, ctx) => {
  // Mirrors todoInputSchema's own "event requires startAt" half of its rule
  // -- an isTask:false proposal with no startTime could never actually save.
  if (!value.isTask && !value.startTime) {
    ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'Event requires a startTime' })
  }
  if (value.endTime && !value.startTime) {
    ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime requires startTime' })
  }
  // Same lexicographic HH:mm comparison scheduleRuleInputSchema already uses.
  if (value.startTime && value.endTime && value.endTime <= value.startTime) {
    ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime must follow startTime' })
  }
  // endTime is deliberately NOT required here, even though todoInputSchema
  // requires both startAt+endAt for an event at save time. This validator
  // only governs the tool-call boundary (model -> staged proposal); the
  // staged proposal's own resolvedInterval() already defaults a missing end
  // to start+1h for conflict-checking ("matching how a bare start time is
  // treated elsewhere in the app"), an existing product policy this doesn't
  // change. Whether the eventual save-time conversion actually applies that
  // same default is a staging->save boundary question, not a model-output
  // boundary one -- that's Epic C-04 "Proposal final validation", not here.
})

// .strict() on every variant: a 'complete'/'delete' call that also carries
// date/startTime/endTime is a sign the model confused this with reschedule
// -- fail closed and let it retry, rather than Zod's default behavior of
// silently stripping the unrecognized fields and proceeding as if they
// were never sent.
export const proposeScheduleUpdateArgsSchema = z.discriminatedUnion('action', [
  z.object({ id: z.string().min(1), action: z.literal('complete') }).strict(),
  z.object({ id: z.string().min(1), action: z.literal('delete') }).strict(),
  z.object({
    id: z.string().min(1),
    action: z.literal('reschedule'),
    // Required -- no more "reschedule with unspecified date defaults to
    // today" (that implicit default was itself the kind of silent guess
    // this boundary exists to remove).
    date: dateExpressionSchema,
    startTime: timeSchema.optional(),
    endTime: timeSchema.optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.endTime && !value.startTime) {
      ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime requires startTime' })
    }
    if (value.startTime && value.endTime && value.endTime <= value.startTime) {
      ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime must follow startTime' })
    }
  }),
])

// durationMinutes is optional and never defaulted downstream (see
// agent-cloud-contract.ts's findFreeSlots) -- its absence means "how free
// am I" (full free-window answer), not "duration unspecified, assume one."
// Found during founder dogfooding: a required-with-implicit-default field
// here was the actual bug behind an empty day answering a plain
// availability question with an arbitrary duration-sized slot.
export const findFreeSlotsArgsSchema = z.object({
  scope: z.enum(['today', 'tomorrow', 'this_week']).or(z.iso.date()),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  windowStart: timeSchema.optional(),
  windowEnd: timeSchema.optional(),
})

export const searchSchedulesArgsSchema = z.object({ from: z.iso.date(), to: z.iso.date() })
  .superRefine((value, ctx) => {
    if (value.from > value.to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must not precede from' })
    }
  })

// get_day_context is meant for "how did day X go" questions, which is a
// natural fit for "how did yesterday go" -- unlike propose_schedule/
// find_free_slots (which only ever look forward), so this uses the
// yesterday-inclusive schema.
export const getDayContextArgsSchema = z.object({
  date: dateExpressionWithYesterdaySchema.optional(),
})
export const getRoutinePreferencesArgsSchema = z.object({})
export const getReviewHistoryArgsSchema = z.object({
  limit: z.number().int().min(1).max(30).optional(),
})
export const proposeRoutineUpdateArgsSchema = z.object({
  dailyReviewEnabled: z.boolean().optional(),
  dailyReviewTime: timeSchema.optional(),
  newsBriefingEnabled: z.boolean().optional(),
  newsBriefingTime: timeSchema.optional(),
  planningPromptTime: timeSchema.optional(),
  notificationsEnabled: z.boolean().optional(),
})
export const proposeReviewActionsArgsSchema = z.object({
  date: dateExpressionWithYesterdaySchema,
  reflection: z.string().trim().min(1).max(4000),
})
export const requestClarificationArgsSchema = z.object({
  question: z.string().trim().min(1).max(500),
  missingFields: z.array(z.string().trim().min(1).max(50)).max(5).optional(),
  reason: z.string().trim().min(1).max(200).optional(),
})

const agentArgsSchemaByTool: Record<string, z.ZodType> = {
  [AGENT_TOOL_NAMES.searchSchedules]: searchSchedulesArgsSchema,
  [AGENT_TOOL_NAMES.findFreeSlots]: findFreeSlotsArgsSchema,
  [AGENT_TOOL_NAMES.proposeSchedule]: proposeScheduleArgsSchema,
  [AGENT_TOOL_NAMES.proposeScheduleUpdate]: proposeScheduleUpdateArgsSchema,
  [AGENT_TOOL_NAMES.getDayContext]: getDayContextArgsSchema,
  [AGENT_TOOL_NAMES.getRoutinePreferences]: getRoutinePreferencesArgsSchema,
  [AGENT_TOOL_NAMES.getReviewHistory]: getReviewHistoryArgsSchema,
  [AGENT_TOOL_NAMES.proposeRoutineUpdate]: proposeRoutineUpdateArgsSchema,
  [AGENT_TOOL_NAMES.proposeReviewActions]: proposeReviewActionsArgsSchema,
  [AGENT_TOOL_NAMES.requestClarification]: requestClarificationArgsSchema,
}

export type AgentArgumentIssue = { field: string; reason: string }

export type AgentToolCallParseResult =
  | { ok: true; args: unknown }
  | { ok: false; kind: 'INVALID_ARGUMENT'; issues: AgentArgumentIssue[] }
  | { ok: false; kind: 'UNSUPPORTED_TOOL' }

/** Validates a model tool-call's raw arguments against this tool's schema
 * before dispatchToolCall's handler ever runs -- on failure, nothing is
 * staged and the model gets back a normalized (not raw ZodIssue) error it
 * can act on. Callers should log the full parsed.error separately if they
 * want the raw issue detail; this only returns the normalized form. */
export function parseAgentToolCall(toolName: string, rawArgs: unknown): AgentToolCallParseResult {
  const schema = agentArgsSchemaByTool[toolName]
  if (!schema) return { ok: false, kind: 'UNSUPPORTED_TOOL' }

  const parsed = schema.safeParse(rawArgs)
  if (!parsed.success) {
    return {
      ok: false,
      kind: 'INVALID_ARGUMENT',
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        reason: issue.message,
      })),
    }
  }
  return { ok: true, args: parsed.data }
}
