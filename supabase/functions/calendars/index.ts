import { apiError, json, withApi } from '../_shared/http.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    if (request.method !== 'GET') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const [calendars, googleConnection] = await Promise.all([
      context.supabase
        .from('user_calendars')
        .select('id,name,purpose,color_token,is_visible,sort_order,created_at,updated_at')
        .order('sort_order')
        .order('id'),
      // Read-only mirror calendar entry, present only while connected. Its id
      // doubles as the calendarId on merged google_calendar_mirror_events rows
      // (see todos GET) so the client's calendarsByID lookup resolves them.
      context.supabase
        .from('google_calendar_connections')
        .select('id,status,created_at,updated_at')
        .eq('status', 'active')
        .maybeSingle(),
    ])

    if (calendars.error) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'calendars',
          error: calendars.error,
        }),
      )
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
    if (googleConnection.error) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'calendars',
          error: googleConnection.error,
        }),
      )
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }

    const items = calendars.data.map((calendar: Record<string, unknown>) => ({
      id: calendar.id,
      name: calendar.name,
      purpose: calendar.purpose,
      colorToken: calendar.color_token,
      isVisible: calendar.is_visible,
      sortOrder: calendar.sort_order,
      provider: 'memdo',
      createdAt: calendar.created_at,
      updatedAt: calendar.updated_at,
    }))

    if (googleConnection.data) {
      items.push({
        id: googleConnection.data.id,
        name: 'Google Calendar',
        purpose: 'external',
        colorToken: null,
        isVisible: true,
        sortOrder: items.length,
        provider: 'google',
        createdAt: googleConnection.data.created_at,
        updatedAt: googleConnection.data.updated_at,
      })
    }

    return json(items, 200, currentRequestId)
  }),
}
