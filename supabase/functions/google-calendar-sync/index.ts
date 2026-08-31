import {
  fetchEventsPage,
  mapGoogleEventToMirrorRow,
  MIRROR_SYNC_WINDOW_FUTURE_DAYS,
  MIRROR_SYNC_WINDOW_PAST_DAYS,
  readRefreshTokenSecret,
  refreshAccessToken,
  serviceClient,
} from '../_shared/google-calendar-contract.ts'
import { constantTimeEquals } from '../_shared/http.ts'

const STALE_AFTER_MS = 10 * 60 * 1000
const MAX_CONNECTIONS_PER_RUN = 50
const MAX_PAGES_PER_CONNECTION = 20

type Connection = {
  id: string
  user_id: string
  google_calendar_id: string
  refresh_token_secret_id: string
  sync_token: string | null
}

async function syncConnection(
  supabase: ReturnType<typeof serviceClient>,
  connection: Connection,
): Promise<void> {
  const refreshToken = await readRefreshTokenSecret(supabase, connection.refresh_token_secret_id)
  if (!refreshToken) throw new Error('missing refresh token secret')

  let tokens
  try {
    tokens = await refreshAccessToken(refreshToken)
  } catch (error) {
    const message = String(error)
    const revoked = message.includes('invalid_grant')
    await supabase.from('google_calendar_connections').update({
      status: revoked ? 'revoked' : 'error',
      last_error: message.slice(0, 500),
    }).eq('id', connection.id)
    return
  }

  let syncToken = connection.sync_token
  let pageToken: string | undefined
  let nextSyncToken: string | undefined
  let pages = 0
  const seenIds = new Set<string>()

  const runPage = async () => {
    try {
      return await fetchEventsPage(tokens.access_token, connection.google_calendar_id, {
        syncToken: syncToken ?? undefined,
        pageToken,
        timeMin: syncToken
          ? undefined
          : new Date(Date.now() - MIRROR_SYNC_WINDOW_PAST_DAYS * 86400000).toISOString(),
        timeMax: syncToken
          ? undefined
          : new Date(Date.now() + MIRROR_SYNC_WINDOW_FUTURE_DAYS * 86400000).toISOString(),
      })
    } catch (error) {
      if ((error as Error & { code?: string }).code === 'SYNC_TOKEN_GONE') {
        syncToken = null
        pageToken = undefined
        return await fetchEventsPage(tokens.access_token, connection.google_calendar_id, {
          timeMin: new Date(Date.now() - MIRROR_SYNC_WINDOW_PAST_DAYS * 86400000).toISOString(),
          timeMax: new Date(Date.now() + MIRROR_SYNC_WINDOW_FUTURE_DAYS * 86400000).toISOString(),
        })
      }
      throw error
    }
  }

  while (pages < MAX_PAGES_PER_CONNECTION) {
    pages += 1
    const page = await runPage()

    const toUpsert = []
    const cancelledIds: string[] = []
    for (const event of page.events) {
      seenIds.add(event.id)
      if (event.status === 'cancelled') {
        cancelledIds.push(event.id)
        continue
      }
      const row = mapGoogleEventToMirrorRow(event, connection.id, connection.user_id)
      if (row) toUpsert.push(row)
    }

    if (toUpsert.length > 0) {
      const upserted = await supabase
        .from('google_calendar_mirror_events')
        .upsert(toUpsert, { onConflict: 'connection_id,google_event_id' })
      if (upserted.error) throw upserted.error
    }
    if (cancelledIds.length > 0) {
      const deleted = await supabase
        .from('google_calendar_mirror_events')
        .delete()
        .eq('connection_id', connection.id)
        .in('google_event_id', cancelledIds)
      if (deleted.error) throw deleted.error
    }

    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken
    if (!page.nextPageToken) break
    pageToken = page.nextPageToken
  }

  await supabase.from('google_calendar_connections').update({
    sync_token: nextSyncToken ?? syncToken,
    status: 'active',
    last_error: null,
    last_synced_at: new Date().toISOString(),
  }).eq('id', connection.id)
}

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
        await syncConnection(supabase, connection as Connection)
        succeeded += 1
      } catch (syncError) {
        failed += 1
        console.error(
          JSON.stringify({
            operation: 'google_calendar.sync',
            connectionId: (connection as Connection).id,
            error: String(syncError),
          }),
        )
        await supabase.from('google_calendar_connections').update({
          status: 'error',
          last_error: String(syncError).slice(0, 500),
        }).eq('id', (connection as Connection).id)
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
