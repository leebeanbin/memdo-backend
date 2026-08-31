import { z } from 'zod'

// Mirrors ScheduleDetail.isActive (ScheduleModel.swift) exactly. A
// 'rescheduled' row in particular is the original left behind by
// reschedule_todo -- it never gets deleted_at set, only its status changes
// (the replacement row is the live one); 'cancelled'/'skipped' are
// similarly dead-but-not-deleted. `deleted_at is null` alone is not the
// same predicate as "active." The single owner of this list -- every
// reader that means "what the user would see as their active schedule"
// (GET /todos, GET /days/{date}, and the Agent's DB-backed tools in
// agent-cloud-contract.ts) filters on it, so the definition can't drift
// between them again the way it did before (founder-dogfooding fix: GET
// /todos and GET /days used to return different item sets for the same
// day than search_schedules/find_free_slots did).
export const DEAD_STATUSES = ['rescheduled', 'cancelled', 'skipped']

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
  meetingUrl: nullableText(2048),
  categoryId: z.uuid().nullable().optional(),
  // Per-todo override (bd18) -- when categoryId is set, a null emoji/color
  // here means "inherit the category's current emoji/color" (derived at
  // read time in todoDto, not copied at creation time); a non-null value
  // here is an explicit override that wins regardless of the category.
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

const todoStatusEnum = z.enum([
  'planned',
  'in_progress',
  'partial',
  'completed',
  'skipped',
  'rescheduled',
  'cancelled',
])

export const todoListQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.array(todoStatusEnum).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: 'from must not follow to',
})

export const todoUpdateSchema = todoInputSchema.and(z.object({
  version: z.number().int().min(1),
  status: todoStatusEnum,
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

type SupabasePort = { from: (table: string) => any }

/** One bulk query for every distinct category_id in a page of todo rows,
 * instead of one query per row -- used to build the `category` argument
 * todoDto expects (bd18). RLS on user_categories already scopes this to
 * the caller's own rows. */
export async function fetchCategoriesByIds(
  supabase: SupabasePort,
  categoryIds: (string | null | undefined)[],
): Promise<Map<string, TodoCategory>> {
  const ids = [...new Set(categoryIds.filter((id): id is string => Boolean(id)))]
  if (!ids.length) return new Map()
  const { data, error } = await supabase
    .from('user_categories')
    .select('id,emoji,color')
    .in('id', ids)
  if (error) throw error
  return new Map(
    (data as { id: string; emoji: string; color: string }[]).map((
      c,
    ) => [c.id, { emoji: c.emoji, color: c.color }]),
  )
}

export const todoSelect =
  'id,scheduled_date,calendar_id,title,entry_kind,is_all_day,note,meeting_url,category_id,emoji,color,start_at,end_at,due_at,location_name,location_address,latitude,longitude,location_provider,location_provider_id,time_bucket,estimated_minutes,reminder_offset_minutes,sort_order,status,progress,source,is_recurrence_exception,schedule_rule_id,rescheduled_from_id,version,completed_at,deleted_at,created_at,updated_at,sync_seq'

export function todoInsert(input: TodoInput, userId: string, id: string, requestHash: string) {
  return {
    id,
    user_id: userId,
    ...todoValues(input),
    // Only set at creation -- todoUpdate must never touch this column, since
    // todoValues() is shared and PATCH callers don't (and shouldn't have to)
    // resend the rule link on every unrelated field edit.
    schedule_rule_id: input.scheduleRuleId ?? null,
    // A client materializing a virtual occurrence (touching it for the first
    // time) goes through this same create path -- keep its provenance
    // consistent with materializeRow() rather than falling through to the
    // 'manual' column default.
    source: input.scheduleRuleId ? 'recurring' : 'manual',
    creation_request_hash: requestHash,
  }
}

// bd14: completed_at previously ran unconditionally on every PATCH where
// status is 'completed' -- fixing a typo on an already-completed item
// silently rewrote its completion timestamp and corrupted summary/review
// history, which reads completed_at to decide what happened "today." Now
// only stamped on the actual not-completed -> completed transition;
// `previousStatus` must be the row's status as it was *before* this update
// (the caller fetches it first). When the item was already completed,
// completed_at is omitted from the returned object entirely (not set to
// `null`) so PostgREST's PATCH leaves the existing column value untouched
// rather than overwriting it with anything at all.
export function todoUpdate(input: TodoUpdateInput, previousStatus: string | null) {
  const values: Record<string, unknown> = {
    ...todoValues(input),
    status: input.status,
    progress: input.status === 'completed' ? 100 : 0,
    version: input.version + 1,
  }
  if (input.status === 'completed') {
    if (previousStatus !== 'completed') values.completed_at = new Date().toISOString()
  } else {
    values.completed_at = null
  }
  return values
}

function todoValues(input: TodoInput) {
  return {
    calendar_id: input.calendarId,
    scheduled_date: input.scheduledDate,
    title: input.title,
    entry_kind: input.entryKind,
    is_all_day: input.isAllDay,
    note: input.note ?? null,
    meeting_url: input.meetingUrl ?? null,
    category_id: input.categoryId ?? null,
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
  }
}

type TodoRow = Record<string, unknown>
type TodoCategory = { emoji: string; color: string }

// bd18: emoji/color are derived here, not read as a frozen creation-time
// copy -- `category` is the joined user_categories row (fetched by the
// caller; see fetchCategoriesByIds in todos/index.ts), and only the todo's
// own emoji/color column (an explicit per-todo override) takes precedence
// over it. A todo with no category and no override still falls through to
// null, same as before this change.
export function todoDto(row: TodoRow, category: TodoCategory | null = null) {
  const locationName = row.location_name as string | null
  return {
    id: row.id,
    scheduledDate: row.scheduled_date,
    calendarId: row.calendar_id,
    title: row.title,
    entryKind: row.entry_kind,
    isAllDay: row.is_all_day,
    note: row.note,
    meetingUrl: row.meeting_url,
    categoryId: row.category_id,
    emoji: row.emoji ?? category?.emoji ?? null,
    color: row.color ?? category?.color ?? null,
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
