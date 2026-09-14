import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  deleteRefreshTokenSecret,
  readRefreshTokenSecret,
  refreshAccessToken,
  revokeGoogleToken,
  serviceClient,
  stopWatchChannel,
} from '../_shared/google-calendar-contract.ts'

// Supabase Edge Functions runtime global (not vanilla Deno) -- schedules
// background work that continues after the response is sent.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

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

      // Google-side cleanup (stop the watch channel, revoke the token,
      // delete the Vault secret) is already fail-open by construction --
      // revokeGoogleToken/stopWatchChannel each swallow their own network
      // errors. Local state (the two writes above, which is everything
      // "disconnected" actually depends on) is already committed at this
      // point, so background the rest instead of making the user-visible
      // response wait on up to 3 sequential Google network round-trips it
      // doesn't need. Matches account/index.ts's existing best-effort-
      // after-local-state-change ordering.
      const refreshTokenSecretId = connection.refresh_token_secret_id as string
      const watchChannelId = connection.watch_channel_id as string | null
      const watchResourceId = connection.watch_resource_id as string | null
      EdgeRuntime.waitUntil(
        (async () => {
          const refreshToken = await readRefreshTokenSecret(supabase, refreshTokenSecretId).catch(
            () => null,
          )
          // Stop the push-notification channel before the token that
          // authorizes stopping it is gone -- best-effort, an already-expired
          // channel 404s harmlessly (stopWatchChannel swallows that itself).
          if (refreshToken && watchChannelId && watchResourceId) {
            const accessToken = await refreshAccessToken(refreshToken).catch(() => null)
            if (accessToken) {
              await stopWatchChannel(accessToken.access_token, watchChannelId, watchResourceId)
            }
          }
          if (refreshToken) await revokeGoogleToken(refreshToken)
          await deleteRefreshTokenSecret(supabase, refreshTokenSecretId).catch((cleanupError) => {
            console.error(
              JSON.stringify({
                requestId: currentRequestId,
                operation: 'google_calendar.disconnect.cleanup',
                error: String(cleanupError),
              }),
            )
          })
        })(),
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
