import { preferencesInputSchema, preferencesValues } from './preferences-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

const valid = {
  updatedAt: '2026-08-31T00:00:00Z',
  timezone: 'Asia/Seoul',
  widgetStyle: 'nextTodo',
  defaultMood: null,
  hideWidgetContent: false,
  notificationsEnabled: true,
  planningPromptTime: '09:00',
  quietHoursStart: null,
  quietHoursEnd: null,
  calendarFilter: [],
  dailyReview: { enabled: true, time: '21:30', days: ['MO', 'TU'], includeReflection: true },
  newsBriefing: { enabled: false, time: null, days: [] },
}

Deno.test('preferences map API names to database values', () => {
  const parsed = preferencesInputSchema.parse(valid)
  const values = preferencesValues(parsed)
  assert(values.widget_style === 'next_todo')
  assert(values.daily_review_time === '21:30')
})

Deno.test('enabled daily review requires a time', () => {
  const result = preferencesInputSchema.safeParse({
    ...valid,
    dailyReview: { ...valid.dailyReview, time: null },
  })
  assert(!result.success)
})

Deno.test('dailyReview.days rejects a repeated weekday (bd26)', () => {
  const result = preferencesInputSchema.safeParse({
    ...valid,
    dailyReview: { ...valid.dailyReview, days: ['MO', 'MO', 'TU'] },
  })
  assert(!result.success)
})

Deno.test('newsBriefing.days rejects a repeated weekday (bd26)', () => {
  const result = preferencesInputSchema.safeParse({
    ...valid,
    newsBriefing: { enabled: true, time: '08:00', days: ['SA', 'SA'] },
  })
  assert(!result.success)
})

Deno.test('preferences require updatedAt for optimistic concurrency (bd19)', () => {
  const { updatedAt: _unused, ...withoutUpdatedAt } = valid
  const result = preferencesInputSchema.safeParse(withoutUpdatedAt)
  assert(!result.success)
})

Deno.test('newsBriefing.time is the unified field name, not localTime (bd19)', () => {
  const parsed = preferencesInputSchema.parse(valid)
  assert(preferencesValues(parsed).news_briefing_time === null)
  const result = preferencesInputSchema.safeParse({
    ...valid,
    newsBriefing: { enabled: false, time: '08:00', days: [] },
  })
  assert(result.success && result.data.newsBriefing.time === '08:00')
})
