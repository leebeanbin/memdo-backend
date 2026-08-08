import { apiError, json, withApi } from '../_shared/http.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    if (request.method !== 'GET') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const { data, error } = await context.supabase
      .from('user_calendars')
      .select('id,name,purpose,color_token,is_visible,sort_order,created_at,updated_at')
      .order('sort_order')
      .order('id')

    if (error) {
      console.error(JSON.stringify({ requestId: currentRequestId, operation: 'calendars', error }))
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }

    return json(
      data.map((calendar: Record<string, unknown>) => ({
        id: calendar.id,
        name: calendar.name,
        purpose: calendar.purpose,
        colorToken: calendar.color_token,
        isVisible: calendar.is_visible,
        sortOrder: calendar.sort_order,
        createdAt: calendar.created_at,
        updatedAt: calendar.updated_at,
      })),
      200,
      currentRequestId,
    )
  }),
}
