import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  classifyGoogleCalendarErrorReason,
  serviceClient,
} from '../_shared/google-calendar-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    if (request.method !== 'GET') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const userId = context.userClaims!.id
    const supabase = serviceClient()

    const { data, error } = await supabase
      .from('google_calendar_connections')
      .select('google_calendar_id,status,last_synced_at,last_error')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) {
      console.error(
        JSON.stringify({ requestId: currentRequestId, operation: 'google_calendar.status', error }),
      )
      return apiError('INTERNAL_ERROR', '연결 상태를 확인하지 못했습니다.', 500, currentRequestId)
    }

    const body = data
      ? {
        connected: data.status === 'active',
        status: data.status,
        calendarId: data.google_calendar_id,
        lastSyncedAt: data.last_synced_at,
        lastError: data.status === 'error'
          ? classifyGoogleCalendarErrorReason(data.last_error)
          : null,
      }
      : {
        connected: false,
        status: 'disconnected',
        calendarId: null,
        lastSyncedAt: null,
        lastError: null,
      }

    logRequest({
      eventName: 'google_calendar.status',
      requestId: currentRequestId,
      routeTemplate: '/google-calendar-status',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: data ? 1 : 0,
    })
    return json(body, 200, currentRequestId)
  }),
}
