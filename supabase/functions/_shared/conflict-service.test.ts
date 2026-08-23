// Agent Domain Fixture Contract: v1
import { type ConflictCandidate, findConflict, type TimeRange } from './conflict-service.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

function at(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(2026, 7, 16, h, m))
}

function range(startHHmm: string, endHHmm: string): TimeRange {
  return { start: at(startHHmm), end: at(endHHmm) }
}

function candidate(
  id: string,
  title: string,
  startHHmm: string,
  endHHmm: string,
): ConflictCandidate {
  return { id, title, start: at(startHHmm), end: at(endHHmm) }
}

Deno.test('conflict/overlap', () => {
  const existing = [candidate('e1', '팀 회의', '10:30', '11:30')]
  const result = findConflict(range('10:00', '11:00'), existing)
  assert(result?.id === 'e1')
})

Deno.test('conflict/adjacent-no-overlap', () => {
  // Touching boundaries (10:00-11:00 vs 11:00-12:00) are not a conflict.
  const existing = [candidate('e1', '팀 회의', '11:00', '12:00')]
  const result = findConflict(range('10:00', '11:00'), existing)
  assert(result === null)
})

Deno.test('conflict/excludes-self', () => {
  const existing = [candidate('a1', '팀 회의', '10:00', '11:00')]
  const result = findConflict(range('10:00', '11:00'), existing, 'a1')
  assert(result === null)
})

Deno.test('conflict/first-match', () => {
  // A and B both overlap the candidate; A appears first in `existing`'s
  // input order -- findConflict returns the first match in that order, not
  // necessarily the chronologically earliest one (they happen to coincide
  // here, but that's not the contract).
  const existing = [
    candidate('a', 'A', '10:30', '11:00'),
    candidate('b', 'B', '11:00', '11:30'),
  ]
  const result = findConflict(range('10:00', '12:00'), existing)
  assert(result?.id === 'a')
})
