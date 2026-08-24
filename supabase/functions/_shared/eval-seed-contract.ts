import { z } from 'zod'
import { stableUuid } from './deterministic-id.ts'
import { addDays } from './rule-contract.ts'

// No timezoneOffsetMinutes -- unlike buildDemoRows (which builds timed
// start_at/end_at instants and genuinely needs it), these are date-only
// rows. Accepting-but-ignoring it would look like "timezone-aware seeding"
// when it isn't; removed rather than left unused.
export const evalSeedSchema = z.object({
  localDate: z.iso.date(),
})

type EvalSeedRowInput = {
  userId: string
  localDate: string
  calendarId: string
}

/** Exactly the 2 items eval/agent-v0's PROPOSE_SCHEDULE_UPDATE fixtures
 * (search-005/006) need to exist for search_schedules to find anything --
 * titled/scheduled to match those fixtures' input text ("아까 만든 치과
 * 일정", "내일 운동 일정") word for word, not the other way around (the
 * corpus was written first; this seed serves it, not vice versa).
 * Deterministic ids (stableUuid) + `deleted_at: null` explicit in every
 * row mean re-running this restores THESE TWO ROWS to the same baseline.
 * Agent eval execution itself never mutates these rows -- manual/app
 * mutations of them are still possible (someone could rename or
 * soft-delete one by hand), but rerunning `eval:seed` always restores the
 * deterministic fixture values regardless. This does NOT make the whole
 * eval account deterministic -- any other, unrelated todo that happens to
 * exist in that account is left completely untouched by this function.
 * Don't read "seeded" as "clean." */
export async function buildEvalSeedRows(input: EvalSeedRowInput) {
  const tomorrow = addDays(input.localDate, 1)
  const row = async (
    key: string,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => ({
    id: await stableUuid(`${input.userId}:eval:${key}`),
    user_id: input.userId,
    calendar_id: input.calendarId,
    status: 'planned',
    progress: 0,
    source: 'manual',
    sort_order: 0,
    deleted_at: null,
    ...values,
  })

  return await Promise.all([
    row('dental-appointment', {
      scheduled_date: input.localDate,
      title: '치과 일정',
      entry_kind: 'task',
      is_all_day: false,
    }),
    row('workout-tomorrow', {
      scheduled_date: tomorrow,
      title: '운동',
      entry_kind: 'task',
      is_all_day: false,
    }),
  ])
}
