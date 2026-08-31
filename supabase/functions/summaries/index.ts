import {
  apiError,
  normalizeZodIssues,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import { summaryQuerySchema, summaryRange } from '../_shared/summary-contract.ts'
import { todoDto, todoSelect } from '../_shared/todo-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/summaries',
      startedAt,
    })

    return await withCrudErrors('summaries.get', currentRequestId, async () => {
      if (request.method !== 'GET') {
        return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
      }

      const url = new URL(request.url)
      const parsed = summaryQuerySchema.safeParse({
        scope: url.searchParams.get('scope') ?? undefined,
        localDate: url.searchParams.get('localDate') ?? undefined,
      })
      if (!parsed.success) {
        return apiError('INVALID_REQUEST', '요약 조건을 확인해 주세요.', 400, currentRequestId, {
          issues: normalizeZodIssues(parsed.error.issues),
        })
      }

      const range = summaryRange(parsed.data.scope, parsed.data.localDate)
      const { data, error } = await context.supabase
        .from('todos')
        .select(todoSelect)
        .eq('entry_kind', 'task')
        .gte('scheduled_date', range.start)
        .lt('scheduled_date', range.end)
        .is('deleted_at', null)
        .not('status', 'in', '("cancelled","skipped","rescheduled")')
        .order('scheduled_date')
        .order('sort_order')
        .order('id')
      if (error) throw error

      const tasks = data.map(todoDto)
      const completed = tasks.filter((task: { status: unknown }) => task.status === 'completed')
      const incomplete = tasks.filter((task: { status: unknown }) => task.status !== 'completed')
      const body = {
        scope: parsed.data.scope,
        start: range.start,
        end: range.end,
        completedCount: completed.length,
        incompleteCount: incomplete.length,
        completed,
        incomplete,
      }
      return success(body, 200, 'summaries.get', tasks.length)
    })
  }),
}
