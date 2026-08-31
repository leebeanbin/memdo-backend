import { z } from 'zod'
import {
  apiError,
  normalizeZodIssues,
  POSTGRES_UNIQUE_VIOLATION,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import { serviceClient } from '../_shared/google-calendar-contract.ts'
import {
  workoutLogCreateSchema,
  workoutLogUpdateDetailsSchema,
} from '../_shared/workout-log-contract.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Maps workout_log_full view row → camelCase DTO that iOS WorkoutLogResponseDTO expects.
function toDTO(row: Row) {
  return {
    id: row.id,
    hkUuid: row.hk_uuid ?? null,
    source: row.source,
    activityType: row.activity_type,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSec: row.duration_sec,
    distanceM: row.distance_m ?? null,
    calories: row.calories ?? null,
    avgHeartRate: row.avg_heart_rate ?? null,
    routeImageUrl: row.route_image_url ?? null,
    photoUrl: row.photo_url ?? null,
    scheduledDate: row.scheduled_date,
    locationName: row.location_name ?? null,
    notes: row.notes ?? '',
    exercises: row.exercises ?? null,
  }
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const userId = context.userClaims!.id
    // Not context.supabase -- this table's RLS posture was never verified
    // (this file never went through withApi before), so it keeps the same
    // service-role client + explicit .eq('user_id', userId) filtering on
    // every query it already had, rather than switching to an RLS-enforced
    // client on unverified trust.
    const supabase = serviceClient()
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/workout-logs',
      startedAt: performance.now(),
    })

    return await withCrudErrors('workout-logs', currentRequestId, async () => {
      const path = new URL(request.url).pathname.split('/').filter(Boolean)
      const workoutLogsIndex = path.lastIndexOf('workout-logs')
      const itemId = path[workoutLogsIndex + 1]
      const action = path[workoutLogsIndex + 2]
      const hasItemPath = z.uuid().safeParse(itemId).success

      if (request.method === 'PATCH' && hasItemPath && action === 'details') {
        return await handleUpdateDetails(
          supabase,
          userId,
          itemId,
          request,
          success,
          currentRequestId,
        )
      }

      if (request.method === 'GET' && !hasItemPath) {
        return await handleList(supabase, userId, new URL(request.url), success, currentRequestId)
      }

      if (request.method === 'POST' && !hasItemPath) {
        return await handleCreate(supabase, userId, request, success, currentRequestId)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}

// ── GET /workout-logs?from=YYYY-MM-DD&to=YYYY-MM-DD ──────────────────────────

async function handleList(
  supabase: Row,
  userId: string,
  url: URL,
  success: ReturnType<typeof successResponder>,
  currentRequestId: string,
) {
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (!from || !to) {
    return apiError(
      'INVALID_REQUEST',
      'from, to 쿼리 파라미터가 필요합니다.',
      400,
      currentRequestId,
    )
  }

  const { data, error } = await supabase
    .from('workout_log_full')
    .select('*')
    .eq('user_id', userId)
    .gte('scheduled_date', from)
    .lte('scheduled_date', to)
    .order('started_at', { ascending: false })
  if (error) throw error

  const items = (data ?? []).map(toDTO)
  return success({ items }, 200, 'workout_logs.list', items.length)
}

// ── POST /workout-logs ────────────────────────────────────────────────────────

async function handleCreate(
  supabase: Row,
  userId: string,
  req: Request,
  success: ReturnType<typeof successResponder>,
  currentRequestId: string,
) {
  const body = await req.json().catch(() => null)
  if (!body) return apiError('INVALID_REQUEST', 'JSON 본문이 필요합니다.', 400, currentRequestId)

  const parsed = workoutLogCreateSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('INVALID_REQUEST', '요청을 확인해 주세요.', 400, currentRequestId, {
      issues: normalizeZodIssues(parsed.error.issues),
    })
  }
  const {
    hkUuid,
    source,
    activityType,
    startedAt,
    endedAt,
    durationSec,
    distanceM,
    calories,
    avgHeartRate,
    routeImageUrl,
    photoUrl,
    scheduledDate,
    locationName,
    notes,
    exercises,
  } = parsed.data

  // Idempotency via hk_uuid (HealthKit's own stable id, not the
  // Idempotency-Key header every other POST endpoint uses) -- a workout can
  // arrive from a HealthKit sync with the same hk_uuid more than once, and
  // the response should be the existing row rather than a duplicate.
  if (hkUuid) {
    const { data: existing } = await supabase
      .from('workout_log_full')
      .select('*')
      .eq('user_id', userId)
      .eq('hk_uuid', hkUuid)
      .maybeSingle()
    if (existing) return success(toDTO(existing), 200, 'workout_logs.create', 1)
  }

  const { data: log, error: logError } = await supabase
    .from('workout_logs')
    .insert({
      user_id: userId,
      hk_uuid: hkUuid ?? null,
      source,
      activity_type: activityType,
      started_at: startedAt,
      ended_at: endedAt,
      duration_sec: durationSec,
      distance_m: distanceM ?? null,
      calories: calories ?? null,
      avg_heart_rate: avgHeartRate ?? null,
      route_image_url: routeImageUrl ?? null,
      photo_url: photoUrl ?? null,
      scheduled_date: scheduledDate,
    })
    .select('id')
    .single()

  if (logError) {
    // Race: two concurrent syncs with the same hk_uuid.
    if (logError.code === POSTGRES_UNIQUE_VIOLATION && hkUuid) {
      const { data: existing } = await supabase
        .from('workout_log_full')
        .select('*')
        .eq('user_id', userId)
        .eq('hk_uuid', hkUuid)
        .maybeSingle()
      if (existing) return success(toDTO(existing), 200, 'workout_logs.create', 1)
    }
    throw logError
  }

  // Details insert is non-fatal -- the view uses COALESCE for missing rows.
  const { error: detailError } = await supabase
    .from('workout_log_details')
    .insert({
      workout_log_id: log.id,
      location_name: locationName ?? null,
      notes: notes ?? '',
      exercises: exercises ?? null,
    })
  if (detailError) {
    console.error(JSON.stringify({
      requestId: currentRequestId,
      operation: 'workout_logs.create.details',
      error: detailError,
    }))
  }

  const { data: full, error: readError } = await supabase
    .from('workout_log_full')
    .select('*')
    .eq('id', log.id)
    .single()
  if (readError) throw readError

  return success(toDTO(full), 201, 'workout_logs.create', 1)
}

// ── PATCH /workout-logs/{id}/details ─────────────────────────────────────────

async function handleUpdateDetails(
  supabase: Row,
  userId: string,
  workoutId: string,
  req: Request,
  success: ReturnType<typeof successResponder>,
  currentRequestId: string,
) {
  const { data: parent, error: parentError } = await supabase
    .from('workout_logs')
    .select('id')
    .eq('id', workoutId)
    .eq('user_id', userId)
    .maybeSingle()
  if (parentError) throw parentError
  if (!parent) {
    return apiError('RESOURCE_NOT_FOUND', '운동 기록을 찾을 수 없습니다.', 404, currentRequestId)
  }

  const body = await req.json().catch(() => null)
  if (!body) return apiError('INVALID_REQUEST', 'JSON 본문이 필요합니다.', 400, currentRequestId)

  const parsedDetails = workoutLogUpdateDetailsSchema.safeParse(body)
  if (!parsedDetails.success) {
    return apiError('INVALID_REQUEST', '요청을 확인해 주세요.', 400, currentRequestId, {
      issues: normalizeZodIssues(parsedDetails.error.issues),
    })
  }
  const { locationName, notes, exercises } = parsedDetails.data

  const { error: upsertError } = await supabase
    .from('workout_log_details')
    .upsert({
      workout_log_id: workoutId,
      location_name: locationName ?? null,
      notes: notes ?? '',
      exercises: exercises ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workout_log_id' })
  if (upsertError) throw upsertError

  const { data: full, error: readError } = await supabase
    .from('workout_log_full')
    .select('*')
    .eq('id', workoutId)
    .single()
  if (readError) throw readError

  return success(toDTO(full), 200, 'workout_logs.update_details', 1)
}
