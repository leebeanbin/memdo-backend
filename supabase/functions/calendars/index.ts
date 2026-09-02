import { z } from 'zod'
import {
  apiError,
  normalizeZodIssues,
  POSTGRES_FOREIGN_KEY_VIOLATION,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import {
  calendarCreateSchema,
  calendarDto,
  calendarInsert,
  calendarSelect,
  calendarUpdateSchema,
  calendarUpdateValues,
} from '../_shared/calendar-contract.ts'
import { serviceClient } from '../_shared/google-calendar-contract.ts'

const GOOGLE_CONNECTION_SELECT = 'id,status,created_at,updated_at,color_token'
const SYNCED_CALENDAR_SELECT = 'id,summary,color_token,created_at,updated_at'

// The "Google Calendar" entry shown alongside real user_calendars rows is
// synthetic -- its id is really google_calendar_connections.id, reused so
// the client's calendarsByID lookup resolves google_calendar_mirror_events'
// calendarId. name/purpose/isVisible are fixed (there's no Memdo-owned
// concept of renaming or hiding someone's actual Google calendar); only
// colorToken is a real, persisted column on the connection row.
function googleConnectionCalendarDto(row: Record<string, unknown>, sortOrder: number) {
  return {
    id: row.id,
    name: 'Google Calendar',
    purpose: 'external',
    colorToken: row.color_token ?? null,
    isVisible: true,
    sortOrder,
    provider: 'google',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// Same synthetic shape as the primary connection's own entry above, one per
// additional calendar the user opted into (google-calendar-synced-calendars)
// -- id doubles as google_calendar_mirror_events.synced_calendar_id so the
// client's calendarsByID lookup resolves those rows too. name is Google's
// own summary for that calendar (e.g. "대한민국의 휴일"), not renamable here
// either, same reasoning as the primary entry.
function googleSyncedCalendarDto(row: Record<string, unknown>, sortOrder: number) {
  return {
    id: row.id,
    name: row.summary,
    purpose: 'external',
    colorToken: row.color_token ?? null,
    isVisible: true,
    sortOrder,
    provider: 'google',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const userId = context.userClaims!.id
    const startedAt = performance.now()
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/calendars',
      startedAt,
    })

    return await withCrudErrors('calendars', currentRequestId, async () => {
      const path = new URL(request.url).pathname.split('/').filter(Boolean)
      const calendarsIndex = path.lastIndexOf('calendars')
      const itemId = path[calendarsIndex + 1]
      const hasItemPath = z.uuid().safeParse(itemId).success

      if (request.method === 'GET' && !hasItemPath) {
        const [calendars, googleConnection] = await Promise.all([
          context.supabase
            .from('user_calendars')
            .select(calendarSelect)
            .order('sort_order')
            .order('id'),
          // Read-only mirror calendar entry, present only while connected. Its id
          // doubles as the calendarId on merged google_calendar_mirror_events rows
          // (see todos GET) so the client's calendarsByID lookup resolves them.
          context.supabase
            .from('google_calendar_connections')
            .select(GOOGLE_CONNECTION_SELECT)
            .eq('status', 'active')
            .maybeSingle(),
        ])

        const queryError = calendars.error ?? googleConnection.error
        if (queryError) throw queryError

        const items = calendars.data.map(calendarDto)

        if (googleConnection.data) {
          items.push(googleConnectionCalendarDto(googleConnection.data, items.length))

          // Additional calendars (holiday calendars, a secondary personal
          // calendar, ...) opted into via google-calendar-synced-calendars --
          // only queried once a connection is actually active, since every
          // row here belongs to one.
          const syncedCalendars = await context.supabase
            .from('google_calendar_synced_calendars')
            .select(SYNCED_CALENDAR_SELECT)
            .eq('connection_id', googleConnection.data.id)
            .order('created_at')
          if (syncedCalendars.error) throw syncedCalendars.error
          for (const row of syncedCalendars.data ?? []) {
            items.push(googleSyncedCalendarDto(row, items.length))
          }
        }

        return success(items, 200, 'calendars.list', items.length)
      }

      if (request.method === 'POST' && !hasItemPath) {
        const parsed = calendarCreateSchema.safeParse(
          await request.json().catch(() => undefined),
        )
        if (!parsed.success) {
          return apiError(
            'INVALID_REQUEST',
            '캘린더 정보를 확인해 주세요.',
            400,
            currentRequestId,
            {
              issues: normalizeZodIssues(parsed.error.issues),
            },
          )
        }

        const { data, error } = await context.supabase
          .from('user_calendars')
          .insert(calendarInsert(parsed.data, userId))
          .select(calendarSelect)
          .single()
        if (error) throw error

        return success(calendarDto(data), 201, 'calendars.create', 1)
      }

      if (request.method === 'PATCH' && hasItemPath) {
        const parsed = calendarUpdateSchema.safeParse(
          await request.json().catch(() => undefined),
        )
        if (!parsed.success) {
          return apiError(
            'INVALID_REQUEST',
            '캘린더 정보를 확인해 주세요.',
            400,
            currentRequestId,
            {
              issues: normalizeZodIssues(parsed.error.issues),
            },
          )
        }

        const { data, error } = await context.supabase
          .from('user_calendars')
          .update(calendarUpdateValues(parsed.data))
          .eq('id', itemId)
          .select(calendarSelect)
          .maybeSingle()
        if (error) throw error
        if (data) {
          return success(calendarDto(data), 200, 'calendars.update', 1)
        }

        // Not a real user_calendars row -- itemId may be the synthetic
        // Google Calendar entry's id (the connection's own id). Only
        // colorToken is a real column there; name/sortOrder/isVisible in
        // the request are accepted (the client always sends a full form)
        // but silently ignored, matching what's actually editable for it.
        //
        // google_calendar_connections only has a SELECT RLS policy (every
        // other write to this table already goes through service-role
        // functions -- OAuth callback, sync, disconnect) -- context.supabase
        // (the user-scoped client) would match this row's WHERE clause but
        // RLS silently filters it to zero rows, returning 200 with no
        // update applied rather than an error. Use the service-role client
        // instead, with the same ownership check RLS would have done
        // (.eq('user_id', userId)) done explicitly here, matching this
        // codebase's existing belt-and-suspenders convention for
        // service-role writes (e.g. reschedule_todo re-checking user_id
        // even under RLS).
        const googleConnection = await serviceClient()
          .from('google_calendar_connections')
          .update({ color_token: parsed.data.colorToken ?? null })
          .eq('id', itemId)
          .eq('user_id', userId)
          .eq('status', 'active')
          .select(GOOGLE_CONNECTION_SELECT)
          .maybeSingle()
        if (googleConnection.error) throw googleConnection.error
        if (googleConnection.data) {
          return success(
            googleConnectionCalendarDto(googleConnection.data, 0),
            200,
            'calendars.update',
            1,
          )
        }

        // Still not found -- itemId may be one of the additional synced
        // calendars (google-calendar-synced-calendars) instead. Same
        // RLS-write-restriction/ownership-check reasoning as the connection
        // update just above; name isn't editable here either (Google's own
        // calendar name, not Memdo's to rename).
        const syncedCalendar = await serviceClient()
          .from('google_calendar_synced_calendars')
          .update({ color_token: parsed.data.colorToken ?? null })
          .eq('id', itemId)
          .eq('user_id', userId)
          .select(SYNCED_CALENDAR_SELECT)
          .maybeSingle()
        if (syncedCalendar.error) throw syncedCalendar.error
        if (!syncedCalendar.data) {
          return apiError('RESOURCE_NOT_FOUND', '캘린더를 찾을 수 없습니다.', 404, currentRequestId)
        }

        return success(
          googleSyncedCalendarDto(syncedCalendar.data, 0),
          200,
          'calendars.update',
          1,
        )
      }

      if (request.method === 'DELETE' && hasItemPath) {
        const current = await context.supabase
          .from('user_calendars')
          .select('id,purpose')
          .eq('id', itemId)
          .maybeSingle()
        if (current.error) throw current.error
        if (!current.data) {
          return apiError('RESOURCE_NOT_FOUND', '캘린더를 찾을 수 없습니다.', 404, currentRequestId)
        }
        // personal/work are signup-only and permanent -- only a custom
        // calendar (created via POST above) can be deleted.
        if (current.data.purpose !== 'custom') {
          return apiError(
            'INVALID_REQUEST',
            '기본 캘린더는 삭제할 수 없습니다.',
            400,
            currentRequestId,
          )
        }

        // Pre-check rather than letting the FK violation surface as a raw
        // 500 -- todos_calendar_user_fkey/schedule_rules_calendar_user_fkey
        // are both on-delete-restrict, and neither one filters by
        // deleted_at (a soft-deleted todo/rule still blocks the calendar
        // FK), so this counts every referencing row regardless of status.
        const [todoCount, ruleCount] = await Promise.all([
          context.supabase
            .from('todos')
            .select('id', { count: 'exact', head: true })
            .eq('calendar_id', itemId),
          context.supabase
            .from('schedule_rules')
            .select('id', { count: 'exact', head: true })
            .eq('calendar_id', itemId),
        ])
        if (todoCount.error) throw todoCount.error
        if (ruleCount.error) throw ruleCount.error
        if ((todoCount.count ?? 0) > 0 || (ruleCount.count ?? 0) > 0) {
          return apiError(
            'INVALID_REQUEST',
            '캘린더에 일정이 남아 있어 삭제할 수 없습니다.',
            400,
            currentRequestId,
          )
        }

        const { error } = await context.supabase
          .from('user_calendars')
          .delete()
          .eq('id', itemId)
        if (error) {
          // Defense in depth against a race between the pre-check above and
          // this delete (a todo/rule created in that window) -- same
          // detect-the-constraint-name pattern as todos' own FK handling
          // (bd10), instead of a raw 500 for what's still a normal, if
          // rare, "calendar not empty" outcome.
          if (error.code === POSTGRES_FOREIGN_KEY_VIOLATION) {
            return apiError(
              'INVALID_REQUEST',
              '캘린더에 일정이 남아 있어 삭제할 수 없습니다.',
              400,
              currentRequestId,
            )
          }
          throw error
        }

        return success({ id: itemId }, 200, 'calendars.delete', 1)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}
