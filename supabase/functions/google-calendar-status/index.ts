import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  classifyGoogleCalendarErrorReason,
  GOOGLE_CALENDAR_PUSH_MAX_ATTEMPTS,
  GOOGLE_CALENDAR_SCOPE,
  serviceClient,
} from '../_shared/google-calendar-contract.ts'

async function loadStatusBody(
  supabase: ReturnType<typeof serviceClient>,
  userId: string,
): Promise<{ body: Record<string, unknown>; returnedRows: number } | { error: unknown }> {
  const { data, error } = await supabase
    .from('google_calendar_connections')
    .select('google_calendar_id,status,last_synced_at,last_error,scope')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return { error }

  // pendingCount/failedCount -- google_calendar_push_queue has no client
  // RLS policy (service-role only), so this is computed here with an
  // explicit .eq('user_id', userId), the same service-client-plus-
  // explicit-ownership-check convention used everywhere else this feature
  // reads that table. Never a blanket count -- always scoped to the
  // requesting user's own rows.
  let pendingCount = 0
  let failedCount = 0
  if (data) {
    const { data: queueRows, error: queueError } = await supabase
      .from('google_calendar_push_queue')
      .select('attempts')
      .eq('user_id', userId)
    if (queueError) return { error: queueError }
    for (const row of queueRows ?? []) {
      if ((row.attempts as number) >= GOOGLE_CALENDAR_PUSH_MAX_ATTEMPTS) failedCount += 1
      else pendingCount += 1
    }
  }

  // needsReconnect: an existing connection whose stored scope predates this
  // app's move from calendar.readonly to full write access -- push 403s
  // forever on this without ever flipping `status` away from 'active'
  // (only a refresh-token failure does that), so it's otherwise completely
  // invisible. Exact-token match on the whitespace-split scope string, NOT
  // a substring check: '.../auth/calendar' is a literal text-prefix of
  // '.../auth/calendar.readonly', so substring matching would
  // false-positive on exactly the broken case.
  const needsReconnect = data
    ? !((data.scope as string | null) ?? '').split(/\s+/).includes(GOOGLE_CALENDAR_SCOPE)
    : false

  // lastError used to only be computed when status === 'error' -- but a
  // rate-limited/unknown sync failure now stays status: 'active' (see
  // google-calendar-sync/google-calendar-webhook's classified handling)
  // while still recording last_error, specifically so this combination
  // (active + a non-null lastError) is visible as "transient, auto-
  // retrying" rather than either silently invisible or misrepresented as
  // needing a reconnect.
  const body = data
    ? {
      connected: data.status === 'active',
      status: data.status,
      calendarId: data.google_calendar_id,
      lastSyncedAt: data.last_synced_at,
      lastError: data.last_error ? classifyGoogleCalendarErrorReason(data.last_error) : null,
      needsReconnect,
      pendingCount,
      failedCount,
    }
    : {
      connected: false,
      status: 'disconnected',
      calendarId: null,
      lastSyncedAt: null,
      lastError: null,
      needsReconnect: false,
      pendingCount: 0,
      failedCount: 0,
    }

  return { body, returnedRows: data ? 1 : 0 }
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    if (request.method !== 'GET' && request.method !== 'POST') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const userId = context.userClaims!.id
    const supabase = serviceClient()

    if (request.method === 'POST') {
      // "다시 시도" -- resets attempts/last_error only for this user's own
      // permanently-failed push rows (attempts >= the retry ceiling),
      // never a blanket reset and never a delete. Scoped by
      // .eq('user_id', userId), not by anything client-supplied.
      const retried = await supabase
        .from('google_calendar_push_queue')
        .update({ attempts: 0, last_error: null })
        .eq('user_id', userId)
        .gte('attempts', GOOGLE_CALENDAR_PUSH_MAX_ATTEMPTS)
        .select('id')
      if (retried.error) {
        console.error(
          JSON.stringify({
            requestId: currentRequestId,
            operation: 'google_calendar.status.retry',
            error: retried.error,
          }),
        )
        return apiError('INTERNAL_ERROR', '다시 시도하지 못했습니다.', 500, currentRequestId)
      }
    }

    const result = await loadStatusBody(supabase, userId)
    if ('error' in result) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'google_calendar.status',
          error: result.error,
        }),
      )
      return apiError('INTERNAL_ERROR', '연결 상태를 확인하지 못했습니다.', 500, currentRequestId)
    }

    logRequest({
      eventName: request.method === 'POST'
        ? 'google_calendar.status.retry'
        : 'google_calendar.status',
      requestId: currentRequestId,
      routeTemplate: '/google-calendar-status',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(result.body),
      returnedRows: result.returnedRows,
    })
    return json(result.body, 200, currentRequestId)
  }),
}
