import { apiError, successResponder, withApi, withCrudErrors } from '../_shared/http.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/calendars',
      startedAt,
    })

    return await withCrudErrors('calendars.list', currentRequestId, async () => {
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

      const queryError = calendars.error ?? googleConnection.error
      if (queryError) throw queryError

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

      return success(items, 200, 'calendars.list', items.length)
    })
  }),
}
