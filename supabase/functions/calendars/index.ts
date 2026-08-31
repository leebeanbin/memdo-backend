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
            .select('id,status,created_at,updated_at')
            .eq('status', 'active')
            .maybeSingle(),
        ])

        const queryError = calendars.error ?? googleConnection.error
        if (queryError) throw queryError

        const items = calendars.data.map(calendarDto)

        if (googleConnection.data) {
          items.push({
            id: googleConnection.data.id,
            name: 'Google Calendar',
            purpose: 'external',
            colorToken: null,
            isVisible: true,
            sortOrder: items.length,
            provider: 'google',
            createdAt: googleConnection.data.created_at,
            updatedAt: googleConnection.data.updated_at,
          })
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
        if (!data) {
          return apiError('RESOURCE_NOT_FOUND', '캘린더를 찾을 수 없습니다.', 404, currentRequestId)
        }

        return success(calendarDto(data), 200, 'calendars.update', 1)
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
