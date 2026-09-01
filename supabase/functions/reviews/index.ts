import { z } from 'zod'
import {
  apiError,
  normalizeZodIssues,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import { reviewInputSchema } from '../_shared/summary-contract.ts'

const dateSchema = z.iso.date()

function reviewDto(row: Record<string, unknown>) {
  return {
    reviewDate: row.review_date,
    reflection: row.reflection,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const userId = context.userClaims!.id
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/reviews',
      startedAt: performance.now(),
    })

    return await withCrudErrors('reviews', currentRequestId, async () => {
      const path = new URL(request.url).pathname.split('/').filter(Boolean)
      const reviewsIndex = path.lastIndexOf('reviews')
      const dateParam = path[reviewsIndex + 1]

      if (request.method === 'GET' && !dateParam) {
        // bd6 (review): over-fetch by one (31, not 30) to detect hasMore
        // honestly -- `data.length === 30` was a false positive whenever
        // the user has EXACTLY 30 reviews total (no more), since hitting
        // the cap and having nothing left are indistinguishable from the
        // count alone. Same over-fetch-by-one pattern todos' own cursor
        // pagination already uses, without building a new cursor
        // mechanism for this endpoint (out of scope here).
        const { data, error } = await context.supabase
          .from('daily_reviews')
          .select('review_date,reflection,created_at,updated_at')
          .order('review_date', { ascending: false })
          .limit(31)
        if (error) throw error
        const hasMore = data.length > 30
        const items = data.slice(0, 30).map(reviewDto)
        return success({ items, hasMore }, 200, 'reviews.list', items.length)
      }

      if (request.method === 'GET' && dateParam) {
        if (!dateSchema.safeParse(dateParam).success) {
          return apiError(
            'INVALID_REQUEST',
            '날짜를 YYYY-MM-DD로 입력해 주세요.',
            400,
            currentRequestId,
          )
        }
        const { data, error } = await context.supabase
          .from('daily_reviews')
          .select('review_date,reflection,created_at,updated_at')
          .eq('review_date', dateParam)
          .maybeSingle()
        if (error) throw error
        if (!data) {
          return apiError('RESOURCE_NOT_FOUND', '회고를 찾을 수 없습니다.', 404, currentRequestId)
        }
        return success(reviewDto(data), 200, 'reviews.get', 1)
      }

      if (request.method === 'PUT' && dateParam) {
        if (!dateSchema.safeParse(dateParam).success) {
          return apiError(
            'INVALID_REQUEST',
            '날짜를 YYYY-MM-DD로 입력해 주세요.',
            400,
            currentRequestId,
          )
        }
        const parsed = reviewInputSchema.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) {
          return apiError('INVALID_REQUEST', '회고 내용을 확인해 주세요.', 400, currentRequestId, {
            issues: normalizeZodIssues(parsed.error.issues),
          })
        }
        const { data, error } = await context.supabase
          .from('daily_reviews')
          .upsert({
            user_id: userId,
            review_date: dateParam,
            reflection: parsed.data.reflection ?? null,
          }, { onConflict: 'user_id,review_date' })
          .select('review_date,reflection,created_at,updated_at')
          .single()
        if (error) throw error
        return success(reviewDto(data), 200, 'reviews.put', 1)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}
