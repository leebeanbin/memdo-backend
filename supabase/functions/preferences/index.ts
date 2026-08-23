import { z } from 'zod'
import { apiError, successResponder, withApi, withCrudErrors } from '../_shared/http.ts'
import {
  preferencesDto,
  preferencesInputSchema,
  preferencesValues,
} from '../_shared/preferences-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/preferences',
      startedAt: performance.now(),
    })

    return await withCrudErrors('preferences', currentRequestId, async () => {
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
        return success(preferencesDto(data), 200, 'preferences.get', 1)
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
        return success(preferencesDto(data), 200, 'preferences.put', 1)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}
