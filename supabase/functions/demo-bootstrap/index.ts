import { buildDemoRows, demoBootstrapSchema } from '../_shared/demo-contract.ts'
import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    if (request.method !== 'POST') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }
    if (Deno.env.get('MEMDO_DEMO_SEED_ENABLED') !== 'true') {
      return apiError(
        'RESOURCE_NOT_FOUND',
        '요청한 기능을 찾을 수 없습니다.',
        404,
        currentRequestId,
      )
    }
    if (context.jwtClaims?.is_anonymous !== true) {
      return apiError(
        'FORBIDDEN',
        '개발용 익명 사용자만 사용할 수 있습니다.',
        403,
        currentRequestId,
      )
    }

    const parsed = demoBootstrapSchema.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) {
      return apiError(
        'INVALID_REQUEST',
        '개발 데이터 조건을 확인해 주세요.',
        400,
        currentRequestId,
        {
          issues: parsed.error.issues,
        },
      )
    }

    try {
      const existing = await context.supabase
        .from('todos')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
      if (existing.error) throw existing.error

      let seededCount = 0
      if ((existing.count ?? 0) === 0) {
        const calendars = await context.supabase
          .from('user_calendars')
          .select('id,purpose')
          .in('purpose', ['personal', 'work'])
        if (calendars.error) throw calendars.error

        const personal = calendars.data.find((item: Record<string, unknown>) =>
          item.purpose === 'personal'
        )
        const work = calendars.data.find((item: Record<string, unknown>) => item.purpose === 'work')
        if (!personal || !work) {
          return apiError(
            'RESOURCE_NOT_FOUND',
            '기본 캘린더를 찾을 수 없습니다.',
            404,
            currentRequestId,
          )
        }

        const rows = await buildDemoRows({
          userId: context.userClaims!.id,
          localDate: parsed.data.localDate,
          timezoneOffsetMinutes: parsed.data.timezoneOffsetMinutes,
          personalCalendarId: personal.id,
          workCalendarId: work.id,
        })
        const inserted = await context.supabase.from('todos').upsert(rows, { onConflict: 'id' })
        if (inserted.error) throw inserted.error
        seededCount = rows.length
      }

      const body = { seededCount }
      logRequest({
        eventName: 'demo.bootstrap',
        requestId: currentRequestId,
        routeTemplate: '/demo-bootstrap',
        method: request.method,
        status: 200,
        durationMs: performance.now() - startedAt,
        responseBytes: responseByteLength(body),
        returnedRows: seededCount,
      })
      return json(body, 200, currentRequestId)
    } catch (error) {
      console.error(
        JSON.stringify({ requestId: currentRequestId, operation: 'demo.bootstrap', error }),
      )
      return apiError('INTERNAL_ERROR', '개발 데이터를 준비하지 못했습니다.', 500, currentRequestId)
    }
  }),
}
