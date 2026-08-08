import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import { searchQuerySchema } from '../_shared/search-contract.ts'
import { todoDto } from '../_shared/todo-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    if (request.method !== 'GET') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const url = new URL(request.url)
    const parsed = searchQuerySchema.safeParse({
      q: url.searchParams.get('q') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 20),
    })
    if (!parsed.success) {
      return apiError('INVALID_REQUEST', '검색어를 확인해 주세요.', 400, currentRequestId, {
        issues: parsed.error.issues,
      })
    }

    const { data, error } = await context.supabase
      .rpc('search_todos', { p_query: parsed.data.q, p_limit: parsed.data.limit + 1 })
    if (error) {
      console.error(JSON.stringify({ requestId: currentRequestId, operation: 'search', error }))
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }

    const rows = data as Record<string, unknown>[]
    const hasMore = rows.length > parsed.data.limit
    const items = rows.slice(0, parsed.data.limit)
    const body = { items: items.map(todoDto), hasMore }

    logRequest({
      eventName: 'search',
      requestId: currentRequestId,
      routeTemplate: '/search',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: items.length,
    })
    return json(body, 200, currentRequestId)
  }),
}
