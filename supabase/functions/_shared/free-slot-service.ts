export type TimeRange = { start: Date; end: Date }

/** Returns at most one earliest duration-sized candidate per contiguous
 * free gap between `busy` ranges inside [windowStart, windowEnd), capped at
 * `maxResults`. Does NOT enumerate every possible slot within a gap -- a
 * 3-hour gap with a 30-minute duration returns one 30-minute candidate at
 * the gap's start, not six. Sorts `busy` and drops invalid ranges
 * (end <= start) internally; callers don't need to pre-sort or pre-filter.
 *
 * `busy` ranges are clipped to [windowStart, windowEnd) before the gap walk
 * runs (a range entirely outside the window is dropped, one that straddles
 * a window edge is trimmed to the part inside it) -- without this, a busy
 * range starting after windowEnd would otherwise be read as "the window is
 * entirely free," producing a candidate that extends past windowEnd.
 *
 * Service-level input contract (this function, not its callers, owns these
 * checks -- it's now a standalone domain function other future callers may
 * reach without going through a Tool's own argument validation):
 *   windowEnd <= windowStart -> []
 *   durationMs <= 0          -> []
 *   maxResults <= 0          -> [] */
export function freeSlotsInWindow(
  busy: TimeRange[],
  windowStart: Date,
  windowEnd: Date,
  durationMs: number,
  maxResults = 3,
): TimeRange[] {
  if (windowEnd.getTime() <= windowStart.getTime()) return []
  if (durationMs <= 0) return []
  if (maxResults <= 0) return []

  const clipped = busy
    .map((range) => ({
      start: new Date(Math.max(range.start.getTime(), windowStart.getTime())),
      end: new Date(Math.min(range.end.getTime(), windowEnd.getTime())),
    }))
    .filter((range) => range.end.getTime() > range.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  const slots: TimeRange[] = []
  let cursor = windowStart
  for (const range of clipped) {
    if (range.start.getTime() > cursor.getTime()) {
      if (range.start.getTime() - cursor.getTime() >= durationMs) {
        slots.push({ start: cursor, end: new Date(cursor.getTime() + durationMs) })
      }
    }
    if (range.end.getTime() > cursor.getTime()) cursor = range.end
  }
  if (windowEnd.getTime() - cursor.getTime() >= durationMs) {
    slots.push({ start: cursor, end: new Date(cursor.getTime() + durationMs) })
  }

  return slots.slice(0, maxResults)
}
