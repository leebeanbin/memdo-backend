import {
  apiError,
  normalizeZodIssues,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import { searchQuerySchema } from '../_shared/search-contract.ts'
import { fetchCategoriesByIds, todoDto } from '../_shared/todo-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/search',
      startedAt,
    })

    return await withCrudErrors('search', currentRequestId, async () => {
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
          issues: normalizeZodIssues(parsed.error.issues),
        })
      }

      const { data, error } = await context.supabase
        .rpc('search_todos', { p_query: parsed.data.q, p_limit: parsed.data.limit + 1 })
      if (error) throw error

      const rows = data as Record<string, unknown>[]
      const hasMore = rows.length > parsed.data.limit
      const items = rows.slice(0, parsed.data.limit)
      const categories = await fetchCategoriesByIds(
        context.supabase,
        items.map((row) => row.category_id as string | null),
      )
      const body = {
        items: items.map((row) => todoDto(row, categories.get(row.category_id as string) ?? null)),
        hasMore,
      }
      return success(body, 200, 'search', items.length)
    })
  }),
}
