import {
  createGoogleEvent,
  deleteGoogleEvent,
  type PushableTodo,
  readRefreshTokenSecret,
  refreshAccessToken,
  serviceClient,
  updateGoogleEvent,
} from '../_shared/google-calendar-contract.ts'
import { constantTimeEquals } from '../_shared/http.ts'

// Fallback for the inline best-effort push attempted synchronously by every
// todos write (see queueAndPushGoogleSync in _shared/google-calendar-contract.ts).
// This cron sweeps whatever that attempt didn't manage to deliver -- offline
// Google API, a token needing refresh, a rate limit -- on a 1-minute tick,
// deliberately much tighter than the pull side's 15 minutes since push
// responsiveness is the thing users actually notice.
const MAX_QUEUE_ROWS_PER_RUN = 100
const MAX_ATTEMPTS = 10

type QueueRow = {
  id: string
  todo_id: string
  user_id: string
  connection_id: string
  operation: 'create' | 'update' | 'delete'
  google_event_id: string | null
  attempts: number
}

type ConnectionRow = {
  id: string
  google_calendar_id: string
  refresh_token_secret_id: string
}

async function pushOne(
  supabase: ReturnType<typeof serviceClient>,
  row: QueueRow,
  connection: ConnectionRow,
): Promise<void> {
  const refreshToken = await readRefreshTokenSecret(supabase, connection.refresh_token_secret_id)
  if (!refreshToken) throw new Error('missing refresh token secret')
  const tokens = await refreshAccessToken(refreshToken)

  if (row.operation === 'delete') {
    if (!row.google_event_id) {
      // Nothing to delete on Google's side -- treat as done.
      await supabase.from('google_calendar_push_queue').delete().eq('id', row.id)
      return
    }
    await deleteGoogleEvent(tokens.access_token, connection.google_calendar_id, row.google_event_id)
    await supabase.from('google_calendar_push_queue').delete().eq('id', row.id)
    return
  }

  // create/update both need the todo's CURRENT data -- read live, not a
  // stale snapshot, since this queue row may have sat for a while.
  const { data: todo, error: todoError } = await supabase
    .from('todos')
    .select('id,title,entry_kind,is_all_day,scheduled_date,start_at,end_at,note,location_name')
    .eq('id', row.todo_id)
    .is('deleted_at', null)
    .maybeSingle()
  if (todoError) throw todoError
  if (!todo) {
    // The todo was deleted after this create/update was queued but before
    // this cron reached it -- nothing to push, drop the row.
    await supabase.from('google_calendar_push_queue').delete().eq('id', row.id)
    return
  }
  const pushable = todo as PushableTodo

  if (row.operation === 'create') {
    const result = await createGoogleEvent(
      tokens.access_token,
      connection.google_calendar_id,
      pushable,
    )
    await supabase.from('todos').update({
      google_event_id: result.id,
      google_synced_at: new Date().toISOString(),
    }).eq('id', row.todo_id)
  } else {
    if (!row.google_event_id) throw new Error('update queued with no google_event_id')
    await updateGoogleEvent(
      tokens.access_token,
      connection.google_calendar_id,
      row.google_event_id,
      pushable,
    )
    await supabase.from('todos').update({
      google_synced_at: new Date().toISOString(),
    }).eq('id', row.todo_id)
  }
  await supabase.from('google_calendar_push_queue').delete().eq('id', row.id)
}

export default {
  fetch: async (request: Request): Promise<Response> => {
    const secret = Deno.env.get('GOOGLE_CALENDAR_SYNC_SECRET')
    const auth = request.headers.get('Authorization')
    if (!secret || !auth || !constantTimeEquals(auth, `Bearer ${secret}`)) {
      return new Response('unauthorized', { status: 401 })
    }

    const supabase = serviceClient()

    const { data: rows, error } = await supabase
      .from('google_calendar_push_queue')
      .select('id,todo_id,user_id,connection_id,operation,google_event_id,attempts')
      .lt('attempts', MAX_ATTEMPTS)
      .order('enqueued_at', { ascending: true })
      .limit(MAX_QUEUE_ROWS_PER_RUN)

    if (error) {
      console.error(JSON.stringify({ operation: 'google_calendar.push', error }))
      return new Response('error', { status: 500 })
    }

    const connectionIds = [...new Set((rows ?? []).map((row) => row.connection_id as string))]
    const connectionsById = new Map<string, ConnectionRow>()
    if (connectionIds.length > 0) {
      const { data: connections, error: connectionsError } = await supabase
        .from('google_calendar_connections')
        .select('id,google_calendar_id,refresh_token_secret_id')
        .in('id', connectionIds)
      if (connectionsError) throw connectionsError
      for (const connection of connections ?? []) {
        connectionsById.set(connection.id as string, connection as ConnectionRow)
      }
    }

    let succeeded = 0
    let failed = 0
    for (const row of (rows ?? []) as QueueRow[]) {
      const connection = connectionsById.get(row.connection_id)
      if (!connection) {
        // Connection was disconnected -- its rows cascade-delete already,
        // this is just defensive.
        await supabase.from('google_calendar_push_queue').delete().eq('id', row.id)
        continue
      }
      try {
        await pushOne(supabase, row, connection)
        succeeded += 1
      } catch (pushError) {
        failed += 1
        console.error(
          JSON.stringify({
            operation: 'google_calendar.push',
            queueId: row.id,
            todoId: row.todo_id,
            error: String(pushError),
          }),
        )
        await supabase.from('google_calendar_push_queue').update({
          attempts: row.attempts + 1,
          last_error: String(pushError).slice(0, 500),
        }).eq('id', row.id)
      }
    }

    console.info(
      JSON.stringify({
        service: 'memdo-api',
        eventName: 'google_calendar.push.batch',
        processed: (rows ?? []).length,
        succeeded,
        failed,
      }),
    )
    return Response.json({ processed: (rows ?? []).length, succeeded, failed })
  },
}
