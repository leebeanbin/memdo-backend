import { z } from 'zod'
import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  preferencesDto,
  preferencesInputSchema,
  preferencesValues,
} from '../_shared/preferences-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    const success = (body: unknown, eventName: string) => {
      logRequest({
        eventName,
        requestId: currentRequestId,
        routeTemplate: '/preferences',
        method: request.method,
        status: 200,
        durationMs: performance.now() - startedAt,
        responseBytes: responseByteLength(body),
        returnedRows: 1,
      })
      return json(body, 200, currentRequestId)
    }

    try {
      if (request.method === 'GET') {
        const { data, error } = await context.supabase
          .from('user_preferences')
          .select('*')
          .maybeSingle()
        if (error) throw error
        if (!data) {
          return apiError(
            'RESOURCE_NOT_FOUND',
            '설정을 찾을 수 없습니다. PUT으로 먼저 설정을 저장해 주세요.',
            404,
            currentRequestId,
          )
        }
        return success(preferencesDto(data), 'preferences.get')
      }

      if (request.method === 'PUT') {
        const idempotencyKey = request.headers.get('Idempotency-Key')
        if (!idempotencyKey || !z.uuid().safeParse(idempotencyKey).success) {
          return apiError(
            'INVALID_REQUEST',
            'Idempotency-Key UUID가 필요합니다.',
            400,
            currentRequestId,
          )
        }
        const parsed = preferencesInputSchema.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) {
          return apiError('INVALID_REQUEST', '설정 값을 확인해 주세요.', 400, currentRequestId, {
            issues: parsed.error.issues,
          })
        }
        const { data, error } = await context.supabase
          .from('user_preferences')
          .upsert({ user_id: context.userClaims!.id, ...preferencesValues(parsed.data) })
          .select('*')
          .single()
        if (error) throw error
        return success(preferencesDto(data), 'preferences.put')
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    } catch (error) {
      console.error(
        JSON.stringify({ requestId: currentRequestId, operation: 'preferences', error }),
      )
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
  }),
}
