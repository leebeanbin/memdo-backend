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
        // bd6: unified list envelope -- no cursor/limit exists for this
        // endpoint (it returns every category unconditionally), so
        // hasMore is always false, not a real pagination signal yet.
        const items = data.map(categoryDto)
        return success({ items, hasMore: false }, 200, 'categories.list', items.length)
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

        const rows = parsed.data.categories.map((input, index) => categoryRow(input, userId, index))
        const ids = rows.map((row) => row.id)

        try {
          if (rows.length > 0) {
            // bd20: onConflict target follows the PK, now (id, user_id) --
            // a client-generated id colliding with a DIFFERENT user's
            // category is no longer possible to conflict with, since every
            // row here already carries this caller's own userId.
            const upserted = await context.supabase
              .from('user_categories')
              .upsert(rows, { onConflict: 'id,user_id' })
            if (upserted.error) throw upserted.error
          }

          // bd26: soft delete (deleted_at), matching todos'/schedule_rules'
          // convention (DELETE itself is revoked from authenticated) --
          // this is also what lets /sync report a category removal as a
          // tombstone instead of the row just silently disappearing.
          let pruneQuery = context.supabase
            .from('user_categories')
            .update({ deleted_at: new Date().toISOString() })
            .eq('user_id', userId)
            .is('deleted_at', null)
          pruneQuery = ids.length > 0
            ? pruneQuery.not('id', 'in', `(${ids.join(',')})`)
            : pruneQuery
          const pruned = await pruneQuery
          if (pruned.error) throw pruned.error
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

        // bd6: unified list envelope -- a full-replace call always
        // succeeds in full (no partial application), so hasMore is
        // always false here too.
        return success(
          { items: parsed.data.categories, hasMore: false },
          200,
          'categories.replace',
          rows.length,
        )
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}
