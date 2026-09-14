import {
  readRefreshTokenSecret,
  refreshAccessToken,
  serviceClient,
  stopWatchChannel,
  watchCalendar,
} from '../_shared/google-calendar-contract.ts'
import { constantTimeEquals } from '../_shared/http.ts'

// Google Calendar push-notification channels expire (watchCalendar
// requests a 7-day TTL). Daily cron, well inside that window, so a channel
// is always renewed long before it actually lapses -- if renewal itself
// fails for a run or two, the 15-min pull cron is still the fallback in
// the meantime, real-time delivery just pauses for that connection.
const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000
const MAX_CONNECTIONS_PER_RUN = 50

function webhookAddress(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar-webhook`
}

export default {
  fetch: async (request: Request): Promise<Response> => {
    const secret = Deno.env.get('GOOGLE_CALENDAR_SYNC_SECRET')
    const auth = request.headers.get('Authorization')
    if (!secret || !auth || !constantTimeEquals(auth, `Bearer ${secret}`)) {
      return new Response('unauthorized', { status: 401 })
    }

    const supabase = serviceClient()
    const renewBefore = new Date(Date.now() + RENEW_WITHIN_MS).toISOString()

    const { data: connections, error } = await supabase
      .from('google_calendar_connections')
      .select(
        'id,google_calendar_id,refresh_token_secret_id,watch_channel_id,watch_resource_id,watch_expiration',
      )
      .eq('status', 'active')
      .or(`watch_expiration.is.null,watch_expiration.lt.${renewBefore}`)
      .limit(MAX_CONNECTIONS_PER_RUN)

    if (error) {
      console.error(JSON.stringify({ operation: 'google_calendar.watch_renew', error }))
      return new Response('error', { status: 500 })
    }

    let succeeded = 0
    let failed = 0
    for (const connection of connections ?? []) {
      try {
        const refreshToken = await readRefreshTokenSecret(
          supabase,
          connection.refresh_token_secret_id as string,
        )
        if (!refreshToken) throw new Error('missing refresh token secret')
        const tokens = await refreshAccessToken(refreshToken)

        // Stop the old channel first (best-effort -- watchCalendar mints a
        // fresh channel id regardless, so this is just cleanup on Google's
        // side, not a correctness requirement).
        if (connection.watch_channel_id && connection.watch_resource_id) {
          await stopWatchChannel(
            tokens.access_token,
            connection.watch_channel_id as string,
            connection.watch_resource_id as string,
          )
        }

        const channel = await watchCalendar(
          tokens.access_token,
          connection.google_calendar_id as string,
          webhookAddress(),
        )
        const { error: updateError } = await supabase
          .from('google_calendar_connections')
          .update({
            watch_channel_id: channel.channelId,
            watch_resource_id: channel.resourceId,
            watch_expiration: channel.expiration,
            watch_token: channel.token,
          })
          .eq('id', connection.id)
        if (updateError) throw updateError
        succeeded += 1
      } catch (renewError) {
        failed += 1
        console.error(
          JSON.stringify({
            operation: 'google_calendar.watch_renew',
            connectionId: connection.id,
            error: String(renewError),
          }),
        )
        // Deliberately doesn't mark the connection status 'error' -- a
        // failed *renewal* doesn't mean the connection itself is broken,
        // just that real-time delivery lapses until the next daily retry;
        // the 15-min pull cron keeps working regardless.
      }
    }

    console.info(
      JSON.stringify({
        service: 'memdo-api',
        eventName: 'google_calendar.watch_renew.batch',
        processed: (connections ?? []).length,
        succeeded,
        failed,
      }),
    )
    return Response.json({ processed: (connections ?? []).length, succeeded, failed })
  },
}
