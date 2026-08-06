import { withSupabase } from '@supabase/server'
import { z } from 'zod'
import { apiError, json, logRequest, requestId, responseByteLength } from '../_shared/http.ts'
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
  fetch: withSupabase<any>({ auth: 'user' }, async (request, context) => {
    const startedAt = performance.now()
    const currentRequestId = requestId(request)
    const userId = context.userClaims!.id

    const success = (body: unknown, eventName: string, returnedRows: number) => {
      logRequest({
        eventName,
        requestId: currentRequestId,
        routeTemplate: '/reviews',
        method: request.method,
        status: 200,
        durationMs: performance.now() - startedAt,
        responseBytes: responseByteLength(body),
        returnedRows,
      })
      return json(body, 200, currentRequestId)
    }

    try {
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
        return success(data.map(reviewDto), 'reviews.list', data.length)
      }

      if (request.method === 'PUT' && dateParam) {
        if (!dateSchema.safeParse(dateParam).success) {
          return apiError('INVALID_REQUEST', '날짜를 YYYY-MM-DD로 입력해 주세요.', 400, currentRequestId)
        }
        const parsed = reviewInputSchema.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) {
          return apiError('INVALID_REQUEST', '회고 내용을 확인해 주세요.', 400, currentRequestId, {
            issues: parsed.error.issues,
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
        return success(reviewDto(data), 'reviews.put', 1)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    } catch (error) {
      console.error(JSON.stringify({ requestId: currentRequestId, operation: 'reviews', error }))
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
  }),
}
