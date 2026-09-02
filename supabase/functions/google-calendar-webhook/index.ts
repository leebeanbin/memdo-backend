import {
  type GoogleCalendarSyncConnection,
  serviceClient,
  syncConnection,
} from '../_shared/google-calendar-contract.ts'
import { constantTimeEquals } from '../_shared/http.ts'

// Google's push notification for a watched calendar (see watchCalendar in
// _shared/google-calendar-contract.ts). Carries NO event data -- every
// notification just means "something changed, go check" -- so this always
// re-runs the exact same syncConnection() the 15-min pull cron uses,
// scoped to the one connection the notification names. Google expects a
// fast 200 ack; syncConnection does its own network round trips to Google,
// but this is a personal-scale app (one connection, small event volume),
// so running it inline rather than deferring to a queue is an accepted
// simplification.
export default {
  fetch: async (request: Request): Promise<Response> => {
    const channelId = request.headers.get('X-Goog-Channel-ID')
    const resourceState = request.headers.get('X-Goog-Resource-State')
    const channelToken = request.headers.get('X-Goog-Channel-Token')

    if (!channelId || !channelToken) {
      return new Response('bad request', { status: 400 })
    }

    const supabase = serviceClient()
    const { data: connection, error } = await supabase
      .from('google_calendar_connections')
      .select(
        'id,user_id,google_calendar_id,refresh_token_secret_id,sync_token,status,watch_channel_id,watch_token',
      )
      .eq('watch_channel_id', channelId)
      .maybeSingle()

    if (error) {
      console.error(JSON.stringify({ operation: 'google_calendar.webhook', error }))
      return new Response('error', { status: 500 })
    }
    // Unknown channel id (already stopped/renewed, or a spoofed request) --
    // 200 so Google doesn't keep retrying a channel we no longer track.
    if (!connection) return new Response('ok', { status: 200 })

    // Google does not sign these requests -- the channel token we set at
    // watchCalendar() time, echoed back here, is the only verification that
    // this notification actually came from the channel we registered.
    if (
      !connection.watch_token || !constantTimeEquals(channelToken, connection.watch_token as string)
    ) {
      return new Response('unauthorized', { status: 401 })
    }

    // resourceState 'sync' is the one-time handshake notification sent the
    // moment the channel is created -- nothing changed yet, just acknowledge.
    if (resourceState === 'sync') {
      return new Response('ok', { status: 200 })
    }
    if (connection.status !== 'active') {
      return new Response('ok', { status: 200 })
    }

    try {
      await syncConnection(supabase, connection as GoogleCalendarSyncConnection)
    } catch (syncError) {
      console.error(
        JSON.stringify({
          operation: 'google_calendar.webhook',
          connectionId: connection.id,
          error: String(syncError),
        }),
      )
      await supabase.from('google_calendar_connections').update({
        status: 'error',
        last_error: String(syncError).slice(0, 500),
      }).eq('id', connection.id as string)
      // Still 200 -- Google only cares that the notification was received,
      // not whether our own sync succeeded. The 15-min pull cron retries.
    }

    return new Response('ok', { status: 200 })
  },
}
