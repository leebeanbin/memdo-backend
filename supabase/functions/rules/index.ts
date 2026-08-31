import { z } from 'zod'
import {
  apiError,
  normalizeZodIssues,
  POSTGRES_UNIQUE_VIOLATION,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import {
  firstOccurrence,
  materializeRow,
  ruleSelect,
  scheduleRuleInputSchema,
} from '../_shared/rule-contract.ts'

function ruleDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    title: row.title,
    entryKind: row.entry_kind,
    isAllDay: row.is_all_day,
    note: row.note,
    startTime: row.start_time,
    endTime: row.end_time,
    timeBucket: row.time_bucket,
    reminderOffsetMinutes: row.reminder_offset_minutes,
    frequency: row.frequency,
    interval: row.step_interval,
    anchorDate: row.anchor_date,
    untilDate: row.until_date,
    count: row.occurrence_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const userId = context.userClaims!.id
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/rules',
      startedAt: performance.now(),
    })

    return await withCrudErrors('rules', currentRequestId, async () => {
      const path = new URL(request.url).pathname.split('/').filter(Boolean)
      const rulesIndex = path.lastIndexOf('rules')
      const ruleId = path[rulesIndex + 1]
      const hasItemPath = z.uuid().safeParse(ruleId).success

      if (request.method === 'GET' && !hasItemPath) {
        const { data, error } = await context.supabase
          .from('schedule_rules')
          .select(ruleSelect)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .order('id')
        if (error) throw error
        return success(data.map(ruleDto), 200, 'rules.list', data.length)
      }

      if (request.method === 'GET' && hasItemPath) {
        const { data, error } = await context.supabase
          .from('schedule_rules')
          .select(ruleSelect)
          .eq('id', ruleId)
          .is('deleted_at', null)
          .maybeSingle()
        if (error) throw error
        if (!data) {
          return apiError(
            'RESOURCE_NOT_FOUND',
            '반복 규칙을 찾을 수 없습니다.',
            404,
            currentRequestId,
          )
        }
        return success(ruleDto(data), 200, 'rules.get', 1)
      }

      if (request.method === 'POST' && !hasItemPath) {
        const idempotencyKey = request.headers.get('Idempotency-Key')
        if (!idempotencyKey || !z.uuid().safeParse(idempotencyKey).success) {
          return apiError(
            'INVALID_REQUEST',
            'Idempotency-Key UUID가 필요합니다.',
            400,
            currentRequestId,
          )
        }

        const parsed = scheduleRuleInputSchema.safeParse(
          await request.json().catch(() => undefined),
        )
        if (!parsed.success) {
          return apiError('INVALID_REQUEST', '반복 규칙을 확인해 주세요.', 400, currentRequestId, {
            issues: normalizeZodIssues(parsed.error.issues),
          })
        }
        const input = parsed.data

        const inserted = await context.supabase
          .from('schedule_rules')
          .insert({
            id: idempotencyKey,
            user_id: userId,
            calendar_id: input.calendarId,
            title: input.title,
            entry_kind: input.entryKind,
            is_all_day: input.isAllDay,
            note: input.note ?? null,
            start_time: input.startTime ?? null,
            end_time: input.endTime ?? null,
            time_bucket: input.timeBucket,
            reminder_offset_minutes: input.reminderOffsetMinutes ?? null,
            frequency: input.frequency,
            step_interval: input.interval,
            anchor_date: input.anchorDate,
            until_date: input.untilDate ?? null,
            occurrence_count: input.count ?? null,
            timezone: input.timezone,
          })
          .select(ruleSelect)
          .single()

        if (inserted.error && inserted.error.code === POSTGRES_UNIQUE_VIOLATION) {
          const existing = await context.supabase
            .from('schedule_rules')
            .select(ruleSelect)
            .eq('id', idempotencyKey)
            .maybeSingle()
          if (existing.error) throw existing.error
          if (!existing.data) {
            return apiError(
              'IDEMPOTENCY_CONFLICT',
              '같은 요청 키가 다른 반복 규칙에 사용되었습니다.',
              409,
              currentRequestId,
            )
          }
          const count = await context.supabase
            .from('todos')
            .select('id', { count: 'exact', head: true })
            .eq('schedule_rule_id', idempotencyKey)
          return success(
            { rule: ruleDto(existing.data), occurrenceCount: count.count ?? 0 },
            201,
            'rules.create',
            1,
          )
        }
        if (inserted.error) throw inserted.error
        const rule = inserted.data

        // task-mode rules keep exactly one materialized occurrence at a time --
        // the current/next one -- and advance to the next on completion (see
        // todos PATCH). event-mode rules materialize nothing at creation; they're
        // computed on demand for whatever range is queried (see todos GET), like
        // Google Calendar/Outlook treat recurring events, since users browse a
        // calendar forward rather than working through one item at a time.
        const rows: Record<string, unknown>[] = []
        if (input.entryKind === 'task') {
          // Not necessarily the anchor date itself -- e.g. a 'weekdays' rule
          // anchored on a Saturday materializes the following Monday.
          const firstDate = firstOccurrence({
            frequency: input.frequency,
            interval: input.interval,
            anchorDate: input.anchorDate,
            untilDate: input.untilDate,
            count: input.count,
          })
          if (firstDate) rows.push(await materializeRow(rule, firstDate, userId))
        }

        if (rows.length > 0) {
          const materialised = await context.supabase.from('todos').upsert(rows, {
            onConflict: 'id',
            ignoreDuplicates: true,
          })
          if (materialised.error) throw materialised.error
        }

        return success(
          { rule: ruleDto(rule), occurrenceCount: rows.length },
          201,
          'rules.create',
          1,
        )
      }

      if (request.method === 'DELETE' && hasItemPath) {
        const localDateParam = new URL(request.url).searchParams.get('localDate')
        const localDateParsed = z.iso.date().safeParse(localDateParam)
        if (!localDateParsed.success) {
          return apiError(
            'INVALID_REQUEST',
            'localDate 쿼리 파라미터(YYYY-MM-DD)가 필요합니다.',
            400,
            currentRequestId,
          )
        }
        // Drop future, non-edited occurrences; keep past ones as history. Uses the
        // client's local calendar date, not UTC — the server has no timezone of its own.
        const today = localDateParsed.data
        const cleared = await context.supabase
          .from('todos')
          .update({ deleted_at: new Date().toISOString() })
          .eq('schedule_rule_id', ruleId)
          .eq('is_recurrence_exception', false)
          .gte('scheduled_date', today)
          .is('deleted_at', null)
        if (cleared.error) throw cleared.error

        // bd21: soft delete, matching todos' convention (DELETE itself is
        // revoked from authenticated) -- a hard delete here would null out
        // schedule_rule_id on every past occurrence kept for history via
        // the on-delete-set-null FK, losing which series they came from.
        const removed = await context.supabase
          .from('schedule_rules')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', ruleId)
          .is('deleted_at', null)
          .select('id')
          .maybeSingle()
        if (removed.error) throw removed.error
        if (!removed.data) {
          return apiError(
            'RESOURCE_NOT_FOUND',
            '반복 규칙을 찾을 수 없습니다.',
            404,
            currentRequestId,
          )
        }
        return success({ id: removed.data.id }, 200, 'rules.delete', 1)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}
