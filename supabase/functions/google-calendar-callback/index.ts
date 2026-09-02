import {
  deleteRefreshTokenSecret,
  exchangeCodeForTokens,
  serializeError,
  serviceClient,
  storeRefreshTokenSecret,
  watchCalendar,
} from '../_shared/google-calendar-contract.ts'

function webhookAddress(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar-webhook`
}

// Google redirects the user's browser here directly -- there is no Memdo
// session/JWT on this request, only the OAuth `code` + `state` Google hands
// back. `state` is the sole proof of "which Memdo user asked for this",
// checked against the single-use nonce google-calendar-start stored.
function appRedirect(status: 'success' | 'error', reason?: string): Response {
  const url = new URL('memdo://google-calendar/callback')
  url.searchParams.set('status', status)
  if (reason) url.searchParams.set('reason', reason)
  return Response.redirect(url.toString(), 302)
}

export default {
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const googleError = url.searchParams.get('error')

    if (googleError) return appRedirect('error', 'denied')
    if (!code || !state) return appRedirect('error', 'invalid_request')

    const supabase = serviceClient()

    const { data: stateRow, error: stateError } = await supabase
      .from('google_calendar_oauth_states')
      .delete()
      .eq('state', state)
      .select('user_id,expires_at')
      .maybeSingle()

    if (stateError || !stateRow) return appRedirect('error', 'invalid_state')
    if (new Date(stateRow.expires_at as string).getTime() < Date.now()) {
      return appRedirect('error', 'expired_state')
    }
    const userId = stateRow.user_id as string

    try {
      const tokens = await exchangeCodeForTokens(code)
      if (!tokens.refresh_token) {
        console.error(
          JSON.stringify({
            operation: 'google_calendar.callback',
            userId,
            error: 'no refresh_token in token exchange response',
          }),
        )
        return appRedirect('error', 'no_refresh_token')
      }

      const { data: existing } = await supabase
        .from('google_calendar_connections')
        .select('id,refresh_token_secret_id')
        .eq('user_id', userId)
        .maybeSingle()

      const secretId = await storeRefreshTokenSecret(supabase, userId, tokens.refresh_token)

      const upserted = await supabase
        .from('google_calendar_connections')
        .upsert(
          {
            user_id: userId,
            refresh_token_secret_id: secretId,
            scope: tokens.scope,
            status: 'active',
            sync_token: null,
            last_error: null,
          },
          { onConflict: 'user_id' },
        )
        .select('id,google_calendar_id')
        .single()
      if (upserted.error) throw upserted.error

      // Real-time pull via push notifications -- fail-open, same as every
      // other best-effort side effect in this codebase (Apple token
      // revocation on account deletion is the precedent): a failed watch
      // registration must never block the connection itself succeeding.
      // The 15-min pull cron (google-calendar-sync) covers this connection
      // regardless of whether this registration succeeds.
      try {
        const channel = await watchCalendar(
          tokens.access_token,
          upserted.data.google_calendar_id as string,
          webhookAddress(),
        )
        await supabase.from('google_calendar_connections').update({
          watch_channel_id: channel.channelId,
          watch_resource_id: channel.resourceId,
          watch_expiration: channel.expiration,
          watch_token: channel.token,
        }).eq('id', upserted.data.id as string)
      } catch (watchError) {
        console.error(
          JSON.stringify({
            operation: 'google_calendar.callback.watch',
            userId,
            error: serializeError(watchError),
          }),
        )
      }

      if (existing?.refresh_token_secret_id) {
        await deleteRefreshTokenSecret(supabase, existing.refresh_token_secret_id).catch(
          (cleanupError) => {
            console.error(
              JSON.stringify({
                operation: 'google_calendar.callback.cleanup',
                userId,
                error: serializeError(cleanupError),
              }),
            )
          },
        )
      }

      return appRedirect('success')
    } catch (error) {
      console.error(
        JSON.stringify({
          operation: 'google_calendar.callback',
          userId,
          error: serializeError(error),
        }),
      )
      return appRedirect('error', 'exchange_failed')
    }
  },
}
