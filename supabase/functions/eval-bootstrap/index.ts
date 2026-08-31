import { buildEvalSeedRows, evalSeedSchema } from '../_shared/eval-seed-contract.ts'
import {
  apiError,
  json,
  logRequest,
  normalizeZodIssues,
  responseByteLength,
  withApi,
} from '../_shared/http.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    if (request.method !== 'POST') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }
    if (Deno.env.get('MEMDO_EVAL_SEED_ENABLED') !== 'true') {
      return apiError(
        'RESOURCE_NOT_FOUND',
        '요청한 기능을 찾을 수 없습니다.',
        404,
        currentRequestId,
      )
    }
    // demo-bootstrap gates on is_anonymous (a structural account property) --
    // the eval account is a real, permanent, BYOK-connected account, so the
    // equivalent gate here is an explicit allowlisted user id, set once via
    // `supabase secrets set` on this dedicated account only. Never derived
    // from anything the caller sends.
    if (context.userClaims!.id !== Deno.env.get('MEMDO_EVAL_ACCOUNT_USER_ID')) {
      return apiError(
        'FORBIDDEN',
        '전용 eval 계정만 사용할 수 있습니다.',
        403,
        currentRequestId,
      )
    }

    const parsed = evalSeedSchema.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) {
      return apiError(
        'INVALID_REQUEST',
        'eval seed 조건을 확인해 주세요.',
        400,
        currentRequestId,
        { issues: normalizeZodIssues(parsed.error.issues) },
      )
    }

    try {
      const calendar = await context.supabase
        .from('user_calendars')
        .select('id')
        .eq('purpose', 'personal')
        .single()
      if (calendar.error || !calendar.data) {
        return apiError(
          'RESOURCE_NOT_FOUND',
          '기본 캘린더를 찾을 수 없습니다.',
          404,
          currentRequestId,
        )
      }

      const rows = await buildEvalSeedRows({
        userId: context.userClaims!.id,
        localDate: parsed.data.localDate,
        calendarId: calendar.data.id,
      })
      const upserted = await context.supabase.from('todos').upsert(rows, { onConflict: 'id' })
      if (upserted.error) throw upserted.error

      // Postcondition: don't just trust that upsert() not erroring means
      // the rows are actually there in the shape we expect. What this
      // needs to guarantee is "치과 일정 today, titled exactly that; 운동
      // tomorrow, titled exactly that" -- id presence and deleted_at alone
      // don't catch a trigger or manual edit that changed title/
      // scheduled_date while leaving the row itself intact. Re-fetch by
      // the same deterministic ids and compare against what
      // buildEvalSeedRows actually generated (not hardcoded expectations)
      // before reporting success. entry_kind/status aren't checked -- not
      // part of what search-005/006 need.
      const ids = rows.map((r) => r.id)
      const verify = await context.supabase
        .from('todos')
        .select('id,title,scheduled_date,deleted_at')
        .in('id', ids)
      if (verify.error) throw verify.error
      const expectedById = new Map(
        rows.map((row) => [row.id, { title: row.title, scheduled_date: row.scheduled_date }]),
      )
      const allValid = ids.every((id) => {
        const actual = verify.data?.find((row: { id: string }) => row.id === id)
        const expected = expectedById.get(id)
        return actual && expected &&
          actual.deleted_at === null &&
          actual.title === expected.title &&
          actual.scheduled_date === expected.scheduled_date
      })
      if (!allValid) {
        return apiError('INTERNAL_ERROR', 'seed 검증에 실패했습니다.', 500, currentRequestId)
      }

      const body = { seededCount: rows.length }
      logRequest({
        eventName: 'eval.bootstrap',
        requestId: currentRequestId,
        routeTemplate: '/eval-bootstrap',
        method: request.method,
        status: 200,
        durationMs: performance.now() - startedAt,
        responseBytes: responseByteLength(body),
        returnedRows: rows.length,
      })
      return json(body, 200, currentRequestId)
    } catch (error) {
      console.error(
        JSON.stringify({ requestId: currentRequestId, operation: 'eval.bootstrap', error }),
      )
      return apiError('INTERNAL_ERROR', 'eval 데이터를 준비하지 못했습니다.', 500, currentRequestId)
    }
  }),
}
