import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  deleteRefreshTokenSecret,
  readRefreshTokenSecret,
  refreshAccessToken,
  revokeGoogleToken,
  serviceClient,
  stopWatchChannel,
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
      .select('id,refresh_token_secret_id,watch_channel_id,watch_resource_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (findError) return disconnectFailed(currentRequestId, findError)

    if (connection) {
      const refreshToken = await readRefreshTokenSecret(
        supabase,
        connection.refresh_token_secret_id as string,
      ).catch(() => null)

      // Stop the push-notification channel before the token that
      // authorizes stopping it is gone -- best-effort, an already-expired
      // channel 404s harmlessly (stopWatchChannel swallows that itself).
      if (refreshToken && connection.watch_channel_id && connection.watch_resource_id) {
        const accessToken = await refreshAccessToken(refreshToken).catch(() => null)
        if (accessToken) {
          await stopWatchChannel(
            accessToken.access_token,
            connection.watch_channel_id as string,
            connection.watch_resource_id as string,
          )
        }
      }

      if (refreshToken) await revokeGoogleToken(refreshToken)

      // Don't delete the user's real Google events -- only unlink Memdo's
      // side, so a future reconnect starts clean instead of risking a stale
      // event id being reused against an unrelated future Google event.
      const unlinked = await supabase
        .from('todos')
        .update({ google_event_id: null, google_synced_at: null })
        .eq('user_id', userId)
        .not('google_event_id', 'is', null)
      if (unlinked.error) return disconnectFailed(currentRequestId, unlinked.error)

      // Mirror rows and any queued google_calendar_push_queue rows
      // cascade-delete via the connection FK.
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
