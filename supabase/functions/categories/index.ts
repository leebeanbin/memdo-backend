import {
  apiError,
  normalizeZodIssues,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import {
  categoriesReplaceSchema,
  categoryDto,
  categorySelect,
} from '../_shared/category-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/categories',
      startedAt: performance.now(),
    })

    return await withCrudErrors('categories', currentRequestId, async () => {
      if (request.method === 'GET') {
        const { data, error } = await context.supabase
          .from('user_categories')
          .select(categorySelect)
          .is('deleted_at', null)
          .order('sort_order')
          .order('id')
        if (error) {
          console.error(
            JSON.stringify({ requestId: currentRequestId, operation: 'categories.list', error }),
          )
          return apiError(
            'INTERNAL_ERROR',
            '카테고리를 불러오지 못했습니다.',
            500,
            currentRequestId,
          )
        }
        const items = data.map(categoryDto)
        return success({ items }, 200, 'categories.list', items.length)
      }

      if (request.method === 'PUT') {
        const parsed = categoriesReplaceSchema.safeParse(
          await request.json().catch(() => undefined),
        )
        if (!parsed.success) {
          return apiError(
            'INVALID_REQUEST',
            '카테고리 목록을 확인해 주세요.',
            400,
            currentRequestId,
            {
              issues: normalizeZodIssues(parsed.error.issues),
            },
          )
        }

        // be17: previously an upsert followed by a separate prune update --
        // a crash between them could commit new/updated categories while
        // never pruning the stale ones. Now one atomic RPC; it derives
        // user_id/deleted_at itself (see the migration), so the raw
        // client-shaped rows are passed straight through with no local
        // user_id/sort_order mapping needed here anymore.
        const { error } = await context.supabase.rpc('replace_user_categories_atomic', {
          p_rows: parsed.data.categories,
        })
        if (error) {
          console.error(
            JSON.stringify({ requestId: currentRequestId, operation: 'categories.replace', error }),
          )
          return apiError(
            'INTERNAL_ERROR',
            '카테고리를 저장하지 못했습니다.',
            500,
            currentRequestId,
          )
        }

        return success(
          { items: parsed.data.categories },
          200,
          'categories.replace',
          parsed.data.categories.length,
        )
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}
