import { z } from 'zod'
import { stableUuid } from './deterministic-id.ts'
import { addDays } from './rule-contract.ts'

export const demoBootstrapSchema = z.object({
  localDate: z.iso.date(),
  timezoneOffsetMinutes: z.number().int().min(-720).max(840),
})

type DemoRowInput = {
  userId: string
  localDate: string
  timezoneOffsetMinutes: number
  personalCalendarId: string
  workCalendarId: string
}

export async function buildDemoRows(input: DemoRowInput) {
  const yesterday = addDays(input.localDate, -1)
  const tomorrow = addDays(input.localDate, 1)
  const row = async (
    key: string,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => ({
    id: await stableUuid(`${input.userId}:${key}`),
    user_id: input.userId,
    status: 'planned',
    progress: 0,
    source: 'manual',
    sort_order: 0,
    ...values,
  })

  return await Promise.all([
    row('completed-prototype-review', {
      calendar_id: input.workCalendarId,
      scheduled_date: yesterday,
      title: '프로토타입 흐름 점검',
      entry_kind: 'task',
      is_all_day: false,
      note: '날짜 선택과 상세 진입 흐름 확인',
      start_at: localInstant(yesterday, 11, 0, input.timezoneOffsetMinutes),
      end_at: localInstant(yesterday, 12, 0, input.timezoneOffsetMinutes),
      due_at: localInstant(yesterday, 12, 0, input.timezoneOffsetMinutes),
      time_bucket: 'morning',
      status: 'completed',
      progress: 100,
      completed_at: localInstant(yesterday, 12, 0, input.timezoneOffsetMinutes),
    }),
    row('product-document', {
      calendar_id: input.workCalendarId,
      scheduled_date: input.localDate,
      title: '앱 기획 문서 다듬기',
      entry_kind: 'task',
      is_all_day: false,
      note: '기능 우선순위와 화면 흐름 정리',
      start_at: localInstant(input.localDate, 10, 0, input.timezoneOffsetMinutes),
      end_at: localInstant(input.localDate, 11, 30, input.timezoneOffsetMinutes),
      due_at: localInstant(input.localDate, 12, 0, input.timezoneOffsetMinutes),
      time_bucket: 'morning',
      reminder_offset_minutes: 30,
    }),
    row('design-review', {
      calendar_id: input.workCalendarId,
      scheduled_date: input.localDate,
      title: '디자인 시안 확인',
      entry_kind: 'event',
      is_all_day: false,
      start_at: localInstant(input.localDate, 14, 30, input.timezoneOffsetMinutes),
      end_at: localInstant(input.localDate, 15, 30, input.timezoneOffsetMinutes),
      location_name: '온라인 미팅',
      location_provider: 'manual',
      time_bucket: 'afternoon',
      reminder_offset_minutes: 10,
      sort_order: 1,
    }),
    row('walk', {
      calendar_id: input.personalCalendarId,
      scheduled_date: input.localDate,
      title: '30분 산책',
      entry_kind: 'task',
      is_all_day: false,
      time_bucket: 'evening',
      location_name: '한강 공원',
      location_provider: 'manual',
      sort_order: 2,
    }),
    row('daily-summary', {
      calendar_id: input.personalCalendarId,
      scheduled_date: input.localDate,
      title: '오늘 요약',
      entry_kind: 'event',
      is_all_day: false,
      start_at: localInstant(input.localDate, 21, 30, input.timezoneOffsetMinutes),
      end_at: localInstant(input.localDate, 21, 45, input.timezoneOffsetMinutes),
      time_bucket: 'evening',
      reminder_offset_minutes: 0,
      sort_order: 3,
    }),
    row('weekly-notes', {
      calendar_id: input.personalCalendarId,
      scheduled_date: tomorrow,
      title: '주간 메모 정리',
      entry_kind: 'task',
      is_all_day: false,
      time_bucket: 'anytime',
    }),
  ])
}

function localInstant(
  day: string,
  hour: number,
  minute: number,
  timezoneOffsetMinutes: number,
): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(
    Date.UTC(year, month - 1, date, hour, minute) - timezoneOffsetMinutes * 60_000,
  ).toISOString()
}
