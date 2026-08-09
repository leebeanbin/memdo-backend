import { z } from 'zod'

const nullableText = (maximum: number) => z.string().max(maximum).nullable().optional()

const locationSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  provider: z.enum(['apple_maps', 'google_places', 'manual']).nullable().optional(),
  providerId: z.string().max(500).nullable().optional(),
})

export const todoInputSchema = z.object({
  scheduledDate: z.iso.date(),
  calendarId: z.uuid(),
  scheduleRuleId: z.uuid().nullable().optional(),
  title: z.string().trim().min(1).max(120),
  entryKind: z.enum(['event', 'task']),
  isAllDay: z.boolean().default(false),
  note: nullableText(2000),
  emoji: z.string().nullable().optional(),
  color: z.enum(['coral', 'amber', 'sage', 'sky', 'indigo', 'violet']).nullable().optional(),
  startAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endAt: z.iso.datetime({ offset: true }).nullable().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  location: locationSchema.nullable().optional(),
  timeBucket: z.enum(['morning', 'afternoon', 'evening', 'anytime']),
  estimatedMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  sortOrder: z.number().int().min(0).default(0),
  reminderOffsetMinutes: z.number().int().min(0).max(10080).nullable().optional(),
}).superRefine((value, context) => {
  if (value.entryKind === 'event' && (!value.startAt || !value.endAt)) {
    context.addIssue({ code: 'custom', message: 'Event requires startAt and endAt' })
  }
  if (value.entryKind === 'event' && value.dueAt) {
    context.addIssue({ code: 'custom', path: ['dueAt'], message: 'Event cannot have dueAt' })
  }
  if (value.startAt && value.endAt && Date.parse(value.endAt) <= Date.parse(value.startAt)) {
    context.addIssue({ code: 'custom', path: ['endAt'], message: 'endAt must follow startAt' })
  }
})

export const todoListQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.array(z.enum([
    'planned',
    'in_progress',
    'partial',
    'completed',
    'skipped',
    'rescheduled',
    'cancelled',
  ])).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: 'from must not follow to',
})

export const todoUpdateSchema = todoInputSchema.and(z.object({
  version: z.number().int().min(1),
  status: z.enum([
    'planned',
    'in_progress',
    'partial',
    'completed',
    'skipped',
    'rescheduled',
    'cancelled',
  ]),
}))

export const todoDeleteSchema = z.object({
  version: z.number().int().min(1),
})

export const todoRescheduleSchema = z.object({
  baseVersion: z.number().int().min(1),
  targetDate: z.iso.date(),
  startAt: z.iso.datetime({ offset: true }).nullable(),
  endAt: z.iso.datetime({ offset: true }).nullable(),
  dueAt: z.iso.datetime({ offset: true }).nullable(),
  timeBucket: z.enum(['morning', 'afternoon', 'evening', 'anytime']),
}).superRefine((value, context) => {
  if ((value.startAt === null) !== (value.endAt === null)) {
    context.addIssue({
      code: 'custom',
      path: ['endAt'],
      message: 'startAt and endAt must be paired',
    })
  }
  if (value.startAt && value.endAt && Date.parse(value.endAt) <= Date.parse(value.startAt)) {
    context.addIssue({ code: 'custom', path: ['endAt'], message: 'endAt must follow startAt' })
  }
})

const todoCursorSchema = z.object({
  scheduledDate: z.iso.date(),
  sortOrder: z.number().int().min(0),
  id: z.uuid(),
})

export type TodoCursor = z.infer<typeof todoCursorSchema>

export function decodeTodoCursor(cursor: string): TodoCursor | null {
  try {
    const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/')
    return todoCursorSchema.parse(JSON.parse(atob(base64)))
  } catch {
    return null
  }
}

export function encodeTodoCursor(row: Record<string, unknown>): string {
  return btoa(JSON.stringify({
    scheduledDate: row.scheduled_date,
    sortOrder: row.sort_order,
    id: row.id,
  })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export type TodoInput = z.infer<typeof todoInputSchema>
export type TodoUpdateInput = z.infer<typeof todoUpdateSchema>

export const todoSelect =
  'id,scheduled_date,calendar_id,title,entry_kind,is_all_day,note,emoji,color,start_at,end_at,due_at,location_name,location_address,latitude,longitude,location_provider,location_provider_id,time_bucket,estimated_minutes,reminder_offset_minutes,sort_order,status,progress,source,is_recurrence_exception,schedule_rule_id,rescheduled_from_id,version,completed_at,deleted_at,created_at,updated_at'

export function todoInsert(input: TodoInput, userId: string, id: string, requestHash: string) {
  return {
    id,
    user_id: userId,
    ...todoValues(input),
    creation_request_hash: requestHash,
  }
}

export function todoUpdate(input: TodoUpdateInput) {
  return {
    ...todoValues(input),
    status: input.status,
    progress: input.status === 'completed' ? 100 : 0,
    completed_at: input.status === 'completed' ? new Date().toISOString() : null,
    version: input.version + 1,
  }
}

function todoValues(input: TodoInput) {
  return {
    calendar_id: input.calendarId,
    scheduled_date: input.scheduledDate,
    title: input.title,
    entry_kind: input.entryKind,
    is_all_day: input.isAllDay,
    note: input.note ?? null,
    emoji: input.emoji ?? null,
    color: input.color ?? null,
    start_at: input.startAt ?? null,
    end_at: input.endAt ?? null,
    due_at: input.dueAt ?? null,
    location_name: input.location?.name ?? null,
    location_address: input.location?.address ?? null,
    latitude: input.location?.latitude ?? null,
    longitude: input.location?.longitude ?? null,
    location_provider: input.location?.provider ?? null,
    location_provider_id: input.location?.providerId ?? null,
    time_bucket: input.timeBucket,
    estimated_minutes: input.estimatedMinutes ?? null,
    reminder_offset_minutes: input.reminderOffsetMinutes ?? null,
    sort_order: input.sortOrder,
    schedule_rule_id: input.scheduleRuleId ?? null,
  }
}

type TodoRow = Record<string, unknown>

export function todoDto(row: TodoRow) {
  const locationName = row.location_name as string | null
  return {
    id: row.id,
    scheduledDate: row.scheduled_date,
    calendarId: row.calendar_id,
    title: row.title,
    entryKind: row.entry_kind,
    isAllDay: row.is_all_day,
    note: row.note,
    emoji: row.emoji,
    color: row.color,
    startAt: row.start_at,
    endAt: row.end_at,
    dueAt: row.due_at,
    location: locationName
      ? {
        name: locationName,
        address: row.location_address,
        latitude: row.latitude,
        longitude: row.longitude,
        provider: row.location_provider,
        providerId: row.location_provider_id,
      }
      : null,
    timeBucket: row.time_bucket,
    estimatedMinutes: row.estimated_minutes,
    reminderOffsetMinutes: row.reminder_offset_minutes,
    sortOrder: row.sort_order,
    status: row.status,
    progress: row.progress,
    source: row.source,
    isRecurrenceException: row.is_recurrence_exception,
    dailyPlanId: null,
    scheduleRuleId: row.schedule_rule_id,
    isVirtual: false,
    rescheduledFromId: row.rescheduled_from_id,
    version: row.version,
    completedAt: row.completed_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
