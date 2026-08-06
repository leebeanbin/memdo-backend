import { withSupabase } from '@supabase/server'
import { z } from 'zod'
import { apiError, json, logRequest, requestId, responseByteLength } from '../_shared/http.ts'
import { expandOccurrences, localInstant, scheduleRuleInputSchema } from '../_shared/rule-contract.ts'

const MAX_MATERIALISED = 200

const ruleSelect =
  'id,calendar_id,title,entry_kind,is_all_day,note,start_time,end_time,time_bucket,reminder_offset_minutes,frequency,step_interval,anchor_date,until_date,occurrence_count,created_at,updated_at'

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

async function occurrenceId(ruleId: string, date: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ruleId}:${date}`)),
  ).slice(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x40
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function horizonEnd(anchorDate: string): string {
  const [year, month, day] = anchorDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 365, 12)).toISOString().slice(0, 10)
}

export default {
  fetch: withSupabase<any>({ auth: 'user' }, async (request, context) => {
    const startedAt = performance.now()
    const currentRequestId = requestId(request)
    const userId = context.userClaims!.id

    const success = (body: unknown, status: number, eventName: string, returnedRows: number) => {
      logRequest({
        eventName,
        requestId: currentRequestId,
        routeTemplate: '/rules',
        method: request.method,
        status,
        durationMs: performance.now() - startedAt,
        responseBytes: responseByteLength(body),
        returnedRows,
      })
      return json(body, status, currentRequestId)
    }

    try {
      const path = new URL(request.url).pathname.split('/').filter(Boolean)
      const rulesIndex = path.lastIndexOf('rules')
      const ruleId = path[rulesIndex + 1]
      const hasItemPath = z.uuid().safeParse(ruleId).success

      if (request.method === 'GET' && !hasItemPath) {
        const { data, error } = await context.supabase
          .from('schedule_rules')
          .select(ruleSelect)
          .order('created_at', { ascending: false })
          .order('id')
        if (error) throw error
        return success(data.map(ruleDto), 200, 'rules.list', data.length)
      }

      if (request.method === 'POST' && !hasItemPath) {
        const parsed = scheduleRuleInputSchema.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) {
          return apiError('INVALID_REQUEST', '반복 규칙을 확인해 주세요.', 400, currentRequestId, {
            issues: parsed.error.issues,
          })
        }
        const input = parsed.data

        const inserted = await context.supabase
          .from('schedule_rules')
          .insert({
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
          })
          .select(ruleSelect)
          .single()
        if (inserted.error) throw inserted.error
        const rule = inserted.data
        const id = rule.id as string

        const occurrences = expandOccurrences(
          {
            frequency: input.frequency,
            interval: input.interval,
            anchorDate: input.anchorDate,
            untilDate: input.untilDate,
            count: input.count,
          },
          input.anchorDate,
          horizonEnd(input.anchorDate),
        ).slice(0, MAX_MATERIALISED)

        const rows = await Promise.all(occurrences.map(async (date) => ({
          id: await occurrenceId(id, date),
          user_id: userId,
          calendar_id: input.calendarId,
          scheduled_date: date,
          title: input.title,
          entry_kind: input.entryKind,
          is_all_day: input.isAllDay,
          note: input.note ?? null,
          start_at: input.startTime ? localInstant(date, input.startTime, input.timezoneOffsetMinutes) : null,
          end_at: input.endTime ? localInstant(date, input.endTime, input.timezoneOffsetMinutes) : null,
          time_bucket: input.timeBucket,
          reminder_offset_minutes: input.reminderOffsetMinutes ?? null,
          status: 'planned',
          progress: 0,
          source: 'recurring',
          is_recurrence_exception: false,
          schedule_rule_id: id,
          sort_order: 0,
          version: 1,
        })))

        if (rows.length > 0) {
          const materialised = await context.supabase.from('todos').upsert(rows, { onConflict: 'id' })
          if (materialised.error) throw materialised.error
        }

        return success({ rule: ruleDto(rule), occurrenceCount: rows.length }, 201, 'rules.create', 1)
      }

      if (request.method === 'DELETE' && hasItemPath) {
        // Drop future, non-edited occurrences; keep past ones as history.
        const today = new Date().toISOString().slice(0, 10)
        const cleared = await context.supabase
          .from('todos')
          .update({ deleted_at: new Date().toISOString() })
          .eq('schedule_rule_id', ruleId)
          .eq('is_recurrence_exception', false)
          .gte('scheduled_date', today)
          .is('deleted_at', null)
        if (cleared.error) throw cleared.error

        const removed = await context.supabase
          .from('schedule_rules')
          .delete()
          .eq('id', ruleId)
          .select('id')
          .maybeSingle()
        if (removed.error) throw removed.error
        if (!removed.data) {
          return apiError('RESOURCE_NOT_FOUND', '반복 규칙을 찾을 수 없습니다.', 404, currentRequestId)
        }
        return success({ id: removed.data.id }, 200, 'rules.delete', 1)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    } catch (error) {
      console.error(JSON.stringify({ requestId: currentRequestId, operation: 'rules', error }))
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
  }),
}
