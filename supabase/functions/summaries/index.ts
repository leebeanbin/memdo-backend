import { withSupabase } from '@supabase/server'
import { apiError, json, logRequest, requestId, responseByteLength } from '../_shared/http.ts'
import { summaryQuerySchema, summaryRange } from '../_shared/summary-contract.ts'
import { todoDto, todoSelect } from '../_shared/todo-contract.ts'

export default {
  fetch: withSupabase<any>({ auth: 'user' }, async (request, context) => {
    const startedAt = performance.now()
    const currentRequestId = requestId(request)

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
        issues: parsed.error.issues,
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
    if (error) {
      console.error(JSON.stringify({ requestId: currentRequestId, operation: 'summaries', error }))
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }

    const tasks = data.map(todoDto)
    const completed = tasks.filter((task) => task.status === 'completed')
    const incomplete = tasks.filter((task) => task.status !== 'completed')
    const body = {
      scope: parsed.data.scope,
      start: range.start,
      end: range.end,
      completedCount: completed.length,
      incompleteCount: incomplete.length,
      completed,
      incomplete,
    }

    logRequest({
      eventName: 'summaries.get',
      requestId: currentRequestId,
      routeTemplate: '/summaries',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: tasks.length,
    })
    return json(body, 200, currentRequestId)
  }),
}
