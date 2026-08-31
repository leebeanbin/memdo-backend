import { z } from 'zod'

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
const weekdays = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])
// bd26 (safe slice): dailyReview.days/newsBriefing.days previously accepted
// duplicate weekdays (e.g. ['MO', 'MO', 'MO']) since z.array(weekdays).max(7)
// only bounds length, not uniqueness.
const weekdaySet = z.array(weekdays).max(7).refine(
  (days) => new Set(days).size === days.length,
  { message: 'weekdays must not repeat' },
)

export const preferencesInputSchema = z.object({
  // bd19: optimistic concurrency -- the client must send back the updatedAt
  // it last read. PUT was previously a blind full-object upsert, so two
  // concurrent single-toggle changes (e.g. one from Settings, one from an
  // approved Agent proposal) built from two different stale reads could
  // silently clobber each other; the loser's toggle just vanishes with no
  // error. Compared by the DB as a timestamptz instant, not by string
  // equality, so 'Z' vs '+00:00' formatting differences don't matter.
  updatedAt: z.iso.datetime({ offset: true }),
  timezone: z.string().min(1).max(100),
  widgetStyle: z.enum(['nextTodo', 'dailyIntention']),
  defaultMood: z.enum(['focus', 'relaxed', 'active', 'recovery', 'excited']).nullable().default(
    null,
  ),
  hideWidgetContent: z.boolean(),
  notificationsEnabled: z.boolean().default(true),
  planningPromptTime: localTime.nullable().default(null),
  quietHoursStart: localTime.nullable().default(null),
  quietHoursEnd: localTime.nullable().default(null),
  calendarFilter: z.array(z.string().max(100)).max(50).default([]),
  dailyReview: z.object({
    enabled: z.boolean(),
    time: localTime.nullable().default(null),
    days: weekdaySet,
    includeReflection: z.boolean().default(true),
  }),
  // bd19: was `localTime`, the only field of its kind not named `time`
  // (dailyReview.time, planningPromptTime, quietHoursStart/End all say
  // `time`/`Time` with no locale qualifier) -- unified since nothing about
  // any of these fields is more or less "local" than the others.
  newsBriefing: z.object({
    enabled: z.boolean(),
    time: localTime.nullable().default(null),
    days: weekdaySet,
  }),
}).superRefine((value, context) => {
  if ((value.quietHoursStart === null) !== (value.quietHoursEnd === null)) {
    context.addIssue({
      code: 'custom',
      path: ['quietHoursEnd'],
      message: 'quiet hours must be paired',
    })
  }
  if (value.dailyReview.enabled && (!value.dailyReview.time || !value.dailyReview.days.length)) {
    context.addIssue({
      code: 'custom',
      path: ['dailyReview'],
      message: 'enabled review requires time and days',
    })
  }
  if (
    value.newsBriefing.enabled && (!value.newsBriefing.time || !value.newsBriefing.days.length)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['newsBriefing'],
      message: 'enabled briefing requires time and days',
    })
  }
})

export type PreferencesInput = z.infer<typeof preferencesInputSchema>

export function preferencesValues(input: PreferencesInput) {
  return {
    timezone: input.timezone,
    widget_style: input.widgetStyle === 'nextTodo' ? 'next_todo' : 'daily_intention',
    default_mood: input.defaultMood,
    hide_widget_content: input.hideWidgetContent,
    notifications_enabled: input.notificationsEnabled,
    planning_prompt_time: input.planningPromptTime,
    quiet_hours_start: input.quietHoursStart,
    quiet_hours_end: input.quietHoursEnd,
    calendar_filter: input.calendarFilter,
    daily_review_enabled: input.dailyReview.enabled,
    daily_review_time: input.dailyReview.time,
    daily_review_days: input.dailyReview.days,
    daily_review_include_reflection: input.dailyReview.includeReflection,
    news_briefing_enabled: input.newsBriefing.enabled,
    news_briefing_time: input.newsBriefing.time,
    news_briefing_days: input.newsBriefing.days,
  }
}

export function preferencesDto(row: Record<string, unknown>) {
  return {
    timezone: row.timezone,
    widgetStyle: row.widget_style === 'daily_intention' ? 'dailyIntention' : 'nextTodo',
    defaultMood: row.default_mood,
    hideWidgetContent: row.hide_widget_content,
    notificationsEnabled: row.notifications_enabled,
    planningPromptTime: row.planning_prompt_time,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    calendarFilter: row.calendar_filter,
    dailyReview: {
      enabled: row.daily_review_enabled,
      time: row.daily_review_time,
      days: row.daily_review_days,
      includeReflection: row.daily_review_include_reflection,
    },
    newsBriefing: {
      enabled: row.news_briefing_enabled,
      time: row.news_briefing_time,
      days: row.news_briefing_days,
      lastGeneratedLocalDate: row.news_briefing_last_generated_date,
    },
    updatedAt: row.updated_at,
  }
}
