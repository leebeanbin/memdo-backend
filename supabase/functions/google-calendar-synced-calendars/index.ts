import { z } from 'zod'
import {
  apiError,
  normalizeZodIssues,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import {
  fetchAvailableGoogleCalendars,
  readRefreshTokenSecret,
  refreshAccessToken,
  serializeError,
  serviceClient,
  syncConnection,
} from '../_shared/google-calendar-contract.ts'

// General "add other Google calendars" support -- previously a connection
// only ever synced its one primary calendar, so a subscribed public
// calendar (a national holiday calendar, a shared team calendar, ...) or a
// secondary personal calendar never showed up in Memdo at all. GET lists
// every calendar on the user's Google account (Calendar's own "다른 캘린더"
// list) merged with which ones are already synced; POST adds one; DELETE
// removes one. The primary calendar itself is out of scope here -- it's
// managed by the connection (connect/disconnect), not this endpoint.
const addSyncedCalendarSchema = z.object({
  googleCalendarId: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(200),
})

const SYNCED_CALENDAR_SELECT = 'id,google_calendar_id,summary,color_token,last_synced_at,last_error'

function syncedCalendarDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    googleCalendarId: row.google_calendar_id,
    summary: row.summary,
    colorToken: row.color_token ?? null,
    lastSyncedAt: row.last_synced_at ?? null,
  }
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const userId = context.userClaims!.id
    const startedAt = performance.now()
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/google-calendar-synced-calendars',
      startedAt,
    })
    const supabase = serviceClient()

    return await withCrudErrors('google_calendar_synced_calendars', currentRequestId, async () => {
      const path = new URL(request.url).pathname.split('/').filter(Boolean)
      const routeIndex = path.lastIndexOf('google-calendar-synced-calendars')
      const itemId = path[routeIndex + 1]
      const hasItemPath = z.uuid().safeParse(itemId).success

      const { data: connection } = await supabase
        .from('google_calendar_connections')
        .select('id,refresh_token_secret_id,google_calendar_id,sync_token')
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle()
      if (!connection) {
        return apiError(
          'INVALID_REQUEST',
          '먼저 Google Calendar를 연결해주세요.',
          400,
          currentRequestId,
        )
      }

      if (request.method === 'GET' && !hasItemPath) {
        const [{ data: synced, error: syncedError }, refreshToken] = await Promise.all([
          supabase
            .from('google_calendar_synced_calendars')
            .select(SYNCED_CALENDAR_SELECT)
            .eq('connection_id', connection.id)
            .order('created_at'),
          readRefreshTokenSecret(supabase, connection.refresh_token_secret_id),
        ])
        if (syncedError) throw syncedError
        if (!refreshToken) {
          return apiError(
            'INVALID_REQUEST',
            '연결이 만료됐어요. 다시 연결해주세요.',
            400,
            currentRequestId,
          )
        }

        let available: Awaited<ReturnType<typeof fetchAvailableGoogleCalendars>>
        try {
          const tokens = await refreshAccessToken(refreshToken)
          available = await fetchAvailableGoogleCalendars(tokens.access_token)
        } catch (error) {
          console.error(
            JSON.stringify({
              requestId: currentRequestId,
              operation: 'google_calendar_synced_calendars.list_available',
              error: serializeError(error),
            }),
          )
          return apiError(
            'INTERNAL_ERROR',
            'Google 캘린더 목록을 가져오지 못했습니다.',
            500,
            currentRequestId,
          )
        }

        const syncedIds = new Set((synced ?? []).map((row) => row.google_calendar_id))
        const items = available
          // The primary calendar is managed by the connection itself
          // (connect/disconnect), not addable/removable here.
          .filter((calendar) => !calendar.primary)
          .map((calendar) => ({
            googleCalendarId: calendar.id,
            summary: calendar.summary,
            isSynced: syncedIds.has(calendar.id),
          }))

        return success(
          { available: items, synced: (synced ?? []).map(syncedCalendarDto) },
          200,
          'google_calendar_synced_calendars.list',
          items.length,
        )
      }

      if (request.method === 'POST' && !hasItemPath) {
        const parsed = addSyncedCalendarSchema.safeParse(
          await request.json().catch(() => undefined),
        )
        if (!parsed.success) {
          return apiError(
            'INVALID_REQUEST',
            '캘린더 정보를 확인해 주세요.',
            400,
            currentRequestId,
            { issues: normalizeZodIssues(parsed.error.issues) },
          )
        }

        const inserted = await supabase
          .from('google_calendar_synced_calendars')
          .insert({
            connection_id: connection.id,
            user_id: userId,
            google_calendar_id: parsed.data.googleCalendarId,
            summary: parsed.data.summary,
          })
          .select(SYNCED_CALENDAR_SELECT)
          .single()
        if (inserted.error) throw inserted.error

        // Best-effort immediate first pull, same "never let a side effect
        // block the primary write" pattern as queueAndPushGoogleSync -- the
        // 15-min google-calendar-sync cron covers it either way if this
        // fails or the connection has a lot to page through.
        try {
          const refreshToken = await readRefreshTokenSecret(
            supabase,
            connection.refresh_token_secret_id,
          )
          if (refreshToken) {
            await syncConnection(supabase, {
              id: connection.id,
              user_id: userId,
              google_calendar_id: connection.google_calendar_id as string,
              refresh_token_secret_id: connection.refresh_token_secret_id,
              sync_token: connection.sync_token as string | null,
            })
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              requestId: currentRequestId,
              operation: 'google_calendar_synced_calendars.initial_pull',
              error: serializeError(error),
            }),
          )
        }

        return success(
          syncedCalendarDto(inserted.data),
          201,
          'google_calendar_synced_calendars.create',
          1,
        )
      }

      if (request.method === 'DELETE' && hasItemPath) {
        const { error } = await supabase
          .from('google_calendar_synced_calendars')
          .delete()
          .eq('id', itemId)
          .eq('user_id', userId)
        if (error) throw error
        return success({ id: itemId }, 200, 'google_calendar_synced_calendars.delete', 1)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}
