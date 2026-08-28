import { AGENT_TOOL_NAMES } from './agent-tool-contract.ts'
import type { AgentTurnTrace, ToolDispatchState } from './agent-cloud-contract.ts'

// Founder/developer-only per-turn debug surface (D2) -- the explicit
// sanitization boundary between ToolDispatchState's raw internal
// args/results and whatever a client is allowed to see.
//
// Why this exists as its own module: ToolDispatchState.dispatchedTools
// carries the REAL args/result each tool handler received/returned,
// `unknown`-typed, exactly as the model and DB produced them. That is
// correct for the tool-calling loop itself (agent-cloud-chat/index.ts
// pushes the model's real tool result back into the conversation) but was,
// before this fix, ALSO what buildDonePayload sent to the client verbatim
// -- meaning a schedule's title, its note, a written reflection, or a
// clarification question could reach the wire unredacted. "No credentials
// are present" was never the right bar: this is user-authored private
// content, not secrets, and both matter.
//
// The rule enforced here is default-deny, explicit-allow: every tool name
// gets its own hand-picked projection of only the fields judged safe to
// show a developer debugging why a turn behaved the way it did (dates,
// counts, structural flags, text LENGTHS) -- never a raw title, note,
// reflection, or question. An unrecognized tool name projects to an empty
// object rather than falling back to "just pass it through," so adding a
// new tool without also deciding its safe projection here fails safe
// (empty), not open (raw).

export type FounderDebugToolCall = {
  name: string
  /** Sanitized projection of what the model supplied -- never a raw
   * title/note/reflection/question, see the tool-by-tool cases below. */
  args: Record<string, unknown>
  /** Sanitized projection of what the handler returned -- same rule.
   * Absent (not merely `{}`) when the handler never actually ran (mirrors
   * ToolDispatchState.dispatchedTools' own `result?` semantics). */
  result?: Record<string, unknown>
}

export type FounderDebugTrace = AgentTurnTrace & {
  toolCalls: FounderDebugToolCall[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Picks only the named keys off a record -- the mechanism the explicit
 * allow-lists below use, so a field simply not listed here can never leak
 * through by accident (as opposed to a denylist, which leaks by default
 * the moment a new field is added upstream and nobody remembers to redact
 * it). */
function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in value && value[key] !== undefined) out[key] = value[key]
  }
  return out
}

/** A free-text field's LENGTH, never its content -- used for every
 * user-authored narrative field (title, note, reflection, clarification
 * question/reason) so a developer can see "the model wrote a 340-character
 * note" without this surface ever carrying what that note actually says. */
function textLength(value: unknown): number | undefined {
  return typeof value === 'string' ? value.length : undefined
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

// ── args projections (what the MODEL supplied) ─────────────────────────

function sanitizeArgs(toolName: string, args: unknown): Record<string, unknown> {
  switch (toolName) {
    case AGENT_TOOL_NAMES.searchSchedules:
      return pick(args, ['from', 'to'])

    case AGENT_TOOL_NAMES.findFreeSlots:
      return pick(args, ['scope', 'durationMinutes', 'windowStart', 'windowEnd'])

    case AGENT_TOOL_NAMES.proposeSchedule:
      return {
        ...pick(args, ['date', 'startTime', 'endTime', 'isTask']),
        // title/note are user-authored free text -- length only, never the
        // text itself. (Undecided whether title specifically is safe
        // enough to show in full; defaulting to the same redaction as note
        // keeps the rule uniform rather than a per-field judgment call.)
        titleLength: textLength(isRecord(args) ? args.title : undefined),
        noteLength: textLength(isRecord(args) ? args.note : undefined),
      }

    case AGENT_TOOL_NAMES.proposeScheduleUpdate:
      // `id` is an opaque row id (from a prior search_schedules result),
      // not user-authored content -- safe to keep for correlating this
      // call with others in the trace.
      return pick(args, ['id', 'action', 'date', 'startTime', 'endTime'])

    case AGENT_TOOL_NAMES.getDayContext:
      return pick(args, ['date'])

    case AGENT_TOOL_NAMES.getRoutinePreferences:
      return {}

    case AGENT_TOOL_NAMES.getReviewHistory:
      return pick(args, ['limit'])

    case AGENT_TOOL_NAMES.proposeRoutineUpdate:
      // Structural settings (times/booleans), not narrative content --
      // safe to pass through directly, same reasoning as
      // get_routine_preferences' result below.
      return pick(args, [
        'dailyReviewEnabled',
        'dailyReviewTime',
        'newsBriefingEnabled',
        'newsBriefingTime',
        'planningPromptTime',
        'notificationsEnabled',
      ])

    case AGENT_TOOL_NAMES.proposeReviewActions:
      return {
        ...pick(args, ['date']),
        reflectionLength: textLength(isRecord(args) ? args.reflection : undefined),
      }

    case AGENT_TOOL_NAMES.requestClarification:
      // question/reason are free text the model wrote -- length only, same
      // uniform rule as every other narrative field, even though `question`
      // typically also becomes the turn's own visible reply text elsewhere.
      // missingFields is a list of short field labels (e.g. "date"), not
      // narrative content, so it's kept as-is.
      return {
        questionLength: textLength(isRecord(args) ? args.question : undefined),
        missingFieldCount: arrayCount(isRecord(args) ? args.missingFields : undefined),
        reasonLength: textLength(isRecord(args) ? args.reason : undefined),
      }

    default:
      return {}
  }
}

// ── result projections (what the HANDLER returned) ─────────────────────

/** propose_schedule/propose_schedule_update's real result shape embeds the
 * conflicting item's TITLE directly in a warning STRING
 * ("Conflicts with existing '<title>'", see handleProposeSchedule/
 * handleProposeScheduleUpdate in agent-cloud-contract.ts) -- reduced here
 * to structural flags only, since that title is exactly the kind of
 * user-authored content this whole module exists to keep off this wire. */
function sanitizeConflictResult(result: unknown): Record<string, unknown> {
  const r = isRecord(result) ? result : {}
  return {
    ok: r.ok === true,
    hasConflict: typeof r.warning === 'string' && r.warning.includes('Conflicts with existing'),
    checkFailed: r.ok === false && typeof r.warning === 'string' &&
      r.warning.startsWith('Could not verify'),
  }
}

function sanitizeResult(toolName: string, result: unknown): Record<string, unknown> {
  switch (toolName) {
    case AGENT_TOOL_NAMES.searchSchedules: {
      // Real shape: { items: [{ id, title, scheduledDate, startAt, endAt }] }
      // or { error }. Titles stripped -- count only.
      const r = isRecord(result) ? result : {}
      return typeof r.error === 'string' ? { error: true } : { count: arrayCount(r.items) }
    }

    case AGENT_TOOL_NAMES.findFreeSlots: {
      // Real shape: { slots: string[] } -- pre-formatted Korean sentences
      // (e.g. "2026-08-16: 09:00-12:00 비어 있어요"), not structured
      // start/end intervals; findFreeSlots doesn't compute or return
      // structured intervals separately today, so only a count is
      // available here without changing that tool's actual contract
      // (out of scope for this privacy fix). slots themselves are times,
      // not user-authored narrative content, but are left out anyway
      // since they're derived display strings, not a value this trace
      // needs to reproduce.
      const r = isRecord(result) ? result : {}
      return typeof r.error === 'string' ? { error: true } : { slotCount: arrayCount(r.slots) }
    }

    case AGENT_TOOL_NAMES.proposeSchedule:
    case AGENT_TOOL_NAMES.proposeScheduleUpdate:
      return sanitizeConflictResult(result)

    case AGENT_TOOL_NAMES.getDayContext: {
      // Real shape includes completed/incomplete arrays of {id, title,...}
      // -- titles stripped, the counts already computed server-side cover
      // the useful debug signal.
      const r = isRecord(result) ? result : {}
      return typeof r.error === 'string'
        ? { error: true }
        : pick(r, ['date', 'completedCount', 'incompleteCount', 'hasReflection'])
    }

    case AGENT_TOOL_NAMES.getRoutinePreferences: {
      // Structural settings (times/booleans/counts), not narrative content
      // -- safe to pass through directly rather than an allow-list of
      // every individual preference key, since preferencesDto's shape is
      // owned by preferences-contract.ts and this would otherwise need to
      // track every field it ever adds.
      const r = isRecord(result) ? result : {}
      return typeof r.error === 'string' ? { error: true } : r
    }

    case AGENT_TOOL_NAMES.getReviewHistory: {
      // Real shape: { reviews: [{ reviewDate, reflection }] } -- reflection
      // is exactly the kind of private free text this module exists to
      // keep off the wire. Dates only, no text.
      const r = isRecord(result) ? result : {}
      if (typeof r.error === 'string') return { error: true }
      const reviews = Array.isArray(r.reviews) ? r.reviews : []
      return {
        count: reviews.length,
        dates: reviews.map((row) => (isRecord(row) ? row.reviewDate : undefined)),
      }
    }

    case AGENT_TOOL_NAMES.proposeRoutineUpdate:
    case AGENT_TOOL_NAMES.proposeReviewActions:
    case AGENT_TOOL_NAMES.requestClarification:
      // Real shape is always { ok: true } for these three -- nothing to
      // redact, but still routed through pick() rather than passed
      // through raw so a future change to any of these handlers doesn't
      // silently start leaking a new field through this default-deny
      // boundary without a deliberate decision here.
      return pick(result, ['ok'])

    default:
      return {}
  }
}

/** The sanitization boundary itself: raw ToolDispatchState.dispatchedTools
 * -> a client-safe FounderDebugTrace. This is the ONLY function that should
 * ever turn `dispatchedTools` into something sent over the wire -- nothing
 * else in agent-cloud-chat/index.ts or agent-cloud-contract.ts should
 * forward dispatchedTools' raw args/result to a client directly. */
export function buildFounderDebugTrace(
  trace: AgentTurnTrace,
  dispatchedTools: ToolDispatchState['dispatchedTools'],
): FounderDebugTrace {
  return {
    ...trace,
    toolCalls: dispatchedTools.map((call) => ({
      name: call.name,
      args: sanitizeArgs(call.name, call.args),
      ...('result' in call ? { result: sanitizeResult(call.name, call.result) } : {}),
    })),
  }
}
