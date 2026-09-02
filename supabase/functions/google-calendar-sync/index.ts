import {
  type GoogleCalendarSyncConnection,
  serviceClient,
  syncConnection,
} from '../_shared/google-calendar-contract.ts'
import { constantTimeEquals } from '../_shared/http.ts'

// The 15-min batch fallback: catches anything the real-time webhook
// (google-calendar-webhook) missed -- a channel that lapsed before renewal,
// a notification Google never delivered, a connection made before webhooks
// existed. Never removed even though push notifications now make most
// syncs near-instant.
const STALE_AFTER_MS = 10 * 60 * 1000
const MAX_CONNECTIONS_PER_RUN = 50

export default {
  fetch: async (request: Request): Promise<Response> => {
    const secret = Deno.env.get('GOOGLE_CALENDAR_SYNC_SECRET')
    const auth = request.headers.get('Authorization')
    // be19: this endpoint's only authentication was a plain string
    // comparison on a publicly reachable route.
    if (!secret || !auth || !constantTimeEquals(auth, `Bearer ${secret}`)) {
      return new Response('unauthorized', { status: 401 })
    }

    const supabase = serviceClient()
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString()

    const { data: connections, error } = await supabase
      .from('google_calendar_connections')
      .select('id,user_id,google_calendar_id,refresh_token_secret_id,sync_token,last_synced_at')
      .eq('status', 'active')
      .or(`last_synced_at.is.null,last_synced_at.lt.${staleBefore}`)
      .order('last_synced_at', { ascending: true, nullsFirst: true })
      .limit(MAX_CONNECTIONS_PER_RUN)

    if (error) {
      console.error(JSON.stringify({ operation: 'google_calendar.sync', error }))
      return new Response('error', { status: 500 })
    }

    let succeeded = 0
    let failed = 0
    for (const connection of connections ?? []) {
      try {
        await syncConnection(supabase, connection as GoogleCalendarSyncConnection)
        succeeded += 1
      } catch (syncError) {
        failed += 1
        console.error(
          JSON.stringify({
            operation: 'google_calendar.sync',
            connectionId: (connection as GoogleCalendarSyncConnection).id,
            error: String(syncError),
          }),
        )
        await supabase.from('google_calendar_connections').update({
          status: 'error',
          last_error: String(syncError).slice(0, 500),
        }).eq('id', (connection as GoogleCalendarSyncConnection).id)
      }
    }

    console.info(
      JSON.stringify({
        service: 'memdo-api',
        eventName: 'google_calendar.sync.batch',
        processed: (connections ?? []).length,
        succeeded,
        failed,
      }),
    )
    return Response.json({ processed: (connections ?? []).length, succeeded, failed })
  },
}
