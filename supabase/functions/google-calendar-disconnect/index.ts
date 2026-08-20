import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  deleteRefreshTokenSecret,
  readRefreshTokenSecret,
  revokeGoogleToken,
  serviceClient,
} from '../_shared/google-calendar-contract.ts'

function disconnectFailed(currentRequestId: string, error: unknown): Response {
  console.error(
    JSON.stringify({ requestId: currentRequestId, operation: 'google_calendar.disconnect', error }),
  )
  return apiError('INTERNAL_ERROR', '연결 해지에 실패했습니다.', 500, currentRequestId)
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    if (request.method !== 'POST') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const userId = context.userClaims!.id
    const supabase = serviceClient()

    const { data: connection, error: findError } = await supabase
      .from('google_calendar_connections')
      .select('id,refresh_token_secret_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (findError) return disconnectFailed(currentRequestId, findError)

    if (connection) {
      const refreshToken = await readRefreshTokenSecret(
        supabase,
        connection.refresh_token_secret_id as string,
      ).catch(() => null)
      if (refreshToken) await revokeGoogleToken(refreshToken)

      // Mirror rows cascade-delete via the connection FK.
      const deleted = await supabase
        .from('google_calendar_connections')
        .delete()
        .eq('id', connection.id)
      if (deleted.error) return disconnectFailed(currentRequestId, deleted.error)

      await deleteRefreshTokenSecret(supabase, connection.refresh_token_secret_id as string).catch(
        (cleanupError) => {
          console.error(
            JSON.stringify({
              requestId: currentRequestId,
              operation: 'google_calendar.disconnect.cleanup',
              error: String(cleanupError),
            }),
          )
        },
      )
    }

    const body = { connected: false }
    logRequest({
      eventName: 'google_calendar.disconnect',
      requestId: currentRequestId,
      routeTemplate: '/google-calendar-disconnect',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: 0,
    })
    return json(body, 200, currentRequestId)
  }),
}
