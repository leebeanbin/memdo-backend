import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  buildAuthorizationUrl,
  OAUTH_STATE_TTL_MS,
  serviceClient,
} from '../_shared/google-calendar-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    if (request.method !== 'POST') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const userId = context.userClaims!.id
    const state = crypto.randomUUID()
    const supabase = serviceClient()

    const inserted = await supabase.from('google_calendar_oauth_states').insert({
      state,
      user_id: userId,
      expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
    })
    if (inserted.error) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'google_calendar.start',
          error: inserted.error,
        }),
      )
      return apiError('INTERNAL_ERROR', '연결을 시작하지 못했습니다.', 500, currentRequestId)
    }

    const body = { authorizationUrl: buildAuthorizationUrl(state) }
    logRequest({
      eventName: 'google_calendar.start',
      requestId: currentRequestId,
      routeTemplate: '/google-calendar-start',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: 0,
    })
    return json(body, 200, currentRequestId)
  }),
}
