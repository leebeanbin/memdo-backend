import { AGENT_TOOL_NAMES } from '../supabase/functions/_shared/agent-tool-contract.ts'

// grade.ts owns GradeVerdict only -- it never decides "skipped", since that's
// an environment/fixture-prerequisite judgment (does this eval account have
// the data a case assumes?), not something derivable from a tool-call
// sequence alone. run.ts is the only place that produces 'skipped' -- see
// its EvalVerdict and the state-dependent-fixture filter it applies before
// ever calling gradeCase().
export type GradeVerdict = 'pass' | 'fail' | 'manual-review'

export type DispatchedTool = { name: string; args: unknown }

export type EvalFixture = {
  id: string
  category: string
  input: string
  expectedBehavior: string
  expected?: Record<string, unknown>
  notes?: string
}

const EXPECTED_TOOL_NAME: Record<string, string | null> = {
  PROPOSE_SCHEDULE: AGENT_TOOL_NAMES.proposeSchedule,
  PROPOSE_SCHEDULE_UPDATE: AGENT_TOOL_NAMES.proposeScheduleUpdate,
  SEARCH_SCHEDULES: AGENT_TOOL_NAMES.searchSchedules,
  FIND_FREE_SLOTS: AGENT_TOOL_NAMES.findFreeSlots,
  CLARIFICATION_REQUIRED: AGENT_TOOL_NAMES.requestClarification,
  ANSWER: null,
  UNSUPPORTED: null,
}

/** Top-level partial match, per the corpus README's "expected is optional
 * and partial -- fill in only the fields worth pinning down for that case."
 * Only keys present in `expected` are checked; extra fields on `actualArgs`
 * that aren't in `expected` always pass (they were never pinned down).
 * Shallow (`===`) comparison -- every current fixture's `expected` values
 * are scalars (strings/booleans), so this is sufficient today. A nested
 * `expected` object would need its own deep-partial matcher; out of scope
 * for this Epic since the corpus doesn't have one yet. */
function argsMismatches(
  expected: Record<string, unknown> | undefined,
  actualArgs: unknown,
): string[] {
  const args = (actualArgs ?? {}) as Record<string, unknown>
  return Object.entries(expected ?? {})
    .filter(([key, value]) => args[key] !== value)
    .map(([key, value]) =>
      `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(args[key])}`
    )
}

/** Tools that stage a real mutation for the user to approve. A case that
 * doesn't expect one of these (SEARCH_SCHEDULES/FIND_FREE_SLOTS/ANSWER/
 * UNSUPPORTED) must never pass just because its own expected read tool also
 * fired -- an unexpected mutation proposal alongside it is a genuine
 * over-eager-mutation failure, not a benign extra call the way an extra
 * read tool (e.g. get_day_context) is. Scoped to exactly these two names,
 * not every propose_* tool -- proposeRoutineUpdate/proposeReviewActions
 * have no corpus coverage yet, so extending this guard to them now would be
 * untested speculation. */
const MUTATION_PROPOSAL_TOOLS = new Set<string>([
  AGENT_TOOL_NAMES.proposeSchedule,
  AGENT_TOOL_NAMES.proposeScheduleUpdate,
])

/** dispatchedTools (the full call sequence, backend tool names =
 * AGENT_TOOL_NAMES values) against the corpus's expectedBehavior label. This
 * file deliberately still doesn't consume iOS's AgentIntent type (Epic J,
 * AgentIntent.swift): grading needs the full ordered dispatchedTools
 * sequence (e.g. "search_schedules before propose_schedule_update"), which a
 * collapsed intent value would throw away, so this file keeps operating on
 * raw tool-call sequences by design -- not because no runtime mechanism
 * exists for these labels (CLARIFICATION_REQUIRED now does: see
 * request_clarification). Pure -- never called for a fixture run.ts has
 * already decided is state-dependent and ungradeable (see run.ts). */
export function gradeCase(
  fixture: Pick<EvalFixture, 'expectedBehavior' | 'expected'>,
  actual: { dispatchedTools: DispatchedTool[] },
): { verdict: GradeVerdict; reason: string } {
  const expectedTool = EXPECTED_TOOL_NAME[fixture.expectedBehavior]

  // Guard first, before anything else -- applies to every category that
  // doesn't itself expect a mutation proposal. For ANSWER/UNSUPPORTED this
  // is redundant with the "any tool call at all is unexpected" check right
  // below (harmless, kept for uniformity); for SEARCH_SCHEDULES/
  // FIND_FREE_SLOTS it's the only thing that catches this failure mode --
  // checking only "did the expected read tool appear" is blind to an
  // unrelated mutation proposal riding along with it.
  if (!MUTATION_PROPOSAL_TOOLS.has(expectedTool ?? '')) {
    const unexpectedMutation = actual.dispatchedTools.find((t) =>
      MUTATION_PROPOSAL_TOOLS.has(t.name)
    )
    if (unexpectedMutation) {
      return {
        verdict: 'fail',
        reason:
          `unexpected mutation proposal ${unexpectedMutation.name} alongside a non-mutating request`,
      }
    }
  }

  if (expectedTool === null) {
    if (actual.dispatchedTools.length > 0) {
      return {
        verdict: 'fail',
        reason: `expected no tool call, got ${
          actual.dispatchedTools.map((t) => t.name).join(', ')
        }`,
      }
    }
    return {
      verdict: 'manual-review',
      reason: "ANSWER vs UNSUPPORTED can't be told apart from text alone",
    }
  }

  const calls = actual.dispatchedTools
    .map((call, index) => ({ ...call, index }))
    .filter((c) => c.name === expectedTool)
  const requiresSearchFirst = fixture.expectedBehavior === 'PROPOSE_SCHEDULE_UPDATE'
  const searchIndex = actual.dispatchedTools.findIndex((t) =>
    t.name === AGENT_TOOL_NAMES.searchSchedules
  )

  if (calls.length === 0) {
    // gradeCase is never called for a state-dependent PROPOSE_SCHEDULE_UPDATE
    // fixture without a deterministic seed account (run.ts filters those to
    // 'skipped' before reaching here), so by the time this branch runs for
    // that category, the caller has already established grading is
    // meaningful: both "search_schedules never attempted" and "searched but
    // no update followed" are plain failures here, not data-availability
    // questions this function has any way to judge.
    if (requiresSearchFirst && searchIndex === -1) {
      return {
        verdict: 'fail',
        reason:
          'expected search_schedules to be attempted before propose_schedule_update, but search_schedules was never called',
      }
    }
    return {
      verdict: 'fail',
      reason: `expected ${expectedTool} in the call sequence, got: ${
        actual.dispatchedTools.map((t) => t.name).join(', ') || '(none)'
      }`,
    }
  }

  // Any call (not necessarily the first) that satisfies both the expected
  // args AND (for updates) the search-before-update ordering makes this a
  // pass -- a model retrying with corrected args, or calling
  // search_schedules again before a later attempt, shouldn't be penalized
  // for an earlier call's mismatch.
  const satisfying = calls.find((call) => {
    const argsOk = argsMismatches(fixture.expected, call.args).length === 0
    const orderOk = !requiresSearchFirst || (searchIndex !== -1 && searchIndex < call.index)
    return argsOk && orderOk
  })
  if (satisfying) {
    return {
      verdict: 'pass',
      reason: 'matched expected tool + args' +
        (requiresSearchFirst ? ' with search_schedules first' : ''),
    }
  }

  const first = calls[0]
  const firstMismatches = argsMismatches(fixture.expected, first.args)
  if (firstMismatches.length > 0) {
    return { verdict: 'fail', reason: firstMismatches.join('; ') }
  }
  return {
    verdict: 'fail',
    reason:
      `expected search_schedules before the matching ${expectedTool} call (index ${first.index}), got: ${
        actual.dispatchedTools.map((t) => t.name).join(' -> ')
      }`,
  }
}
