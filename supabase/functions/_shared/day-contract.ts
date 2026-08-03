type DayTodo = {
  entryKind: unknown
  status: unknown
}

const reviewStatuses = new Set(['planned', 'in_progress', 'partial'])

export function dayViewDto(date: string, todos: DayTodo[]) {
  const needsReviewCount =
    todos.filter((todo) => todo.entryKind === 'task' && reviewStatuses.has(String(todo.status)))
      .length

  return {
    date,
    todos,
    emptyState: todos.length === 0
      ? 'needs_planning'
      : needsReviewCount > 0
      ? 'planned'
      : 'completed',
    needsReviewCount,
  }
}
