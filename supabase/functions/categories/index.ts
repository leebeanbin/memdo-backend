import { apiError, successResponder, withApi, withCrudErrors } from '../_shared/http.ts'
import {
  categoriesReplaceSchema,
  categoryDto,
  categoryRow,
  categorySelect,
} from '../_shared/category-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const userId = context.userClaims!.id
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
              issues: parsed.error.issues,
            },
          )
        }

        const rows = parsed.data.categories.map((input, index) => categoryRow(input, userId, index))
        const ids = rows.map((row) => row.id)

        try {
          if (rows.length > 0) {
            const upserted = await context.supabase
              .from('user_categories')
              .upsert(rows, { onConflict: 'id' })
            if (upserted.error) throw upserted.error
          }

          let deleteQuery = context.supabase.from('user_categories').delete().eq('user_id', userId)
          deleteQuery = ids.length > 0
            ? deleteQuery.not('id', 'in', `(${ids.join(',')})`)
            : deleteQuery
          const deleted = await deleteQuery
          if (deleted.error) throw deleted.error
        } catch (error) {
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

        return success({ items: parsed.data.categories }, 200, 'categories.replace', rows.length)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}
