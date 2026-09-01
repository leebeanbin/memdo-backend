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
        const { data, error } = await context.supabase
          .from('daily_reviews')
          .select('review_date,reflection,created_at,updated_at')
          .order('review_date', { ascending: false })
          .limit(30)
        if (error) throw error
        // bd6: unified list envelope. Unlike calendars/rules/categories/
        // workout-logs (which return every row unconditionally, so
        // hasMore is always false), this query already has a real
        // .limit(30) with no cursor to page past it -- claiming
        // hasMore: false unconditionally would misreport a user with 31+
        // days of review history as having everything. Deriving it from
        // whether the fetch hit the cap is the honest signal available
        // without building a new cursor mechanism (out of scope here).
        const items = data.map(reviewDto)
        return success({ items, hasMore: data.length === 30 }, 200, 'reviews.list', items.length)
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
