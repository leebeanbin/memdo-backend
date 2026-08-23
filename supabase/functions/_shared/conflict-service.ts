export type TimeRange = { start: Date; end: Date }
// id is non-optional: a ConflictCandidate always represents a real existing
// row (from a DB fetch), which always has a real id. "no id to exclude" is
// expressed by findConflict's `excludingId` argument being absent, not by
// an individual candidate lacking one.
export type ConflictCandidate = { id: string; title: string; start: Date; end: Date }

/** Pure interval-overlap detection -- the first existing candidate (in
 * `existing`'s input order, NOT sorted by time) whose interval overlaps
 * `candidate`, or null. `excludingId` skips one candidate (the item being
 * rescheduled must not conflict with itself). Resolving a
 * ProposedScheduleArgs into a TimeRange (date/time token resolution) is
 * NOT this file's job -- that stays in agent-cloud-contract.ts's
 * resolveProposedInterval, which depends on resolveDate/timeOn defined
 * there; importing those here would create a circular import. */
export function findConflict(
  candidate: TimeRange,
  existing: ConflictCandidate[],
  excludingId?: string,
): ConflictCandidate | null {
  for (const item of existing) {
    if (excludingId && item.id === excludingId) continue
    if (candidate.start < item.end && candidate.end > item.start) return item
  }
  return null
}
