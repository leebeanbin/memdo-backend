type DayTodo = {
  entryKind: unknown
  status: unknown
}

const reviewStatuses = new Set(['planned', 'in_progress', 'partial'])

export function dayViewDto(date: string, todos: DayTodo[]) {
  // bd26: a day with only events (entryKind 'event') and zero tasks made
  // needsReviewCount vacuously 0, which this used to read as "completed" --
  // nothing was ever done, there was simply nothing to review. hasTask
  // distinguishes "no outstanding tasks because there are none" from "no
  // outstanding tasks because they're all done."
  const hasTask = todos.some((todo) => todo.entryKind === 'task')
  const needsReviewCount =
    todos.filter((todo) => todo.entryKind === 'task' && reviewStatuses.has(String(todo.status)))
      .length

  return {
    date,
    todos,
    emptyState: todos.length === 0
      ? 'needs_planning'
      : !hasTask || needsReviewCount > 0
      ? 'planned'
      : 'completed',
    needsReviewCount,
  }
}
