import { dayViewDto } from './day-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('day view asks for planning when no schedules exist', () => {
  const view = dayViewDto('2026-08-02', [])

  assert(view.emptyState === 'needs_planning')
  assert(view.needsReviewCount === 0)
})

Deno.test('day view reviews incomplete tasks but not events', () => {
  const view = dayViewDto('2026-08-02', [
    { entryKind: 'event', status: 'planned' },
    { entryKind: 'task', status: 'partial' },
    { entryKind: 'task', status: 'completed' },
  ])

  assert(view.emptyState === 'planned')
  assert(view.needsReviewCount === 1)
})

Deno.test('day view is complete when no tasks need review', () => {
  const view = dayViewDto('2026-08-02', [
    { entryKind: 'event', status: 'planned' },
    { entryKind: 'task', status: 'completed' },
  ])

  assert(view.emptyState === 'completed')
})

Deno.test('day view with only events (no tasks) is not mislabeled "completed" (bd26)', () => {
  const view = dayViewDto('2026-08-02', [
    { entryKind: 'event', status: 'planned' },
    { entryKind: 'event', status: 'planned' },
  ])

  assert(view.emptyState === 'planned')
  assert(view.needsReviewCount === 0)
})
