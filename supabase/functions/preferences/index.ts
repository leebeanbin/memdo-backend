import {
  apiError,
  normalizeZodIssues,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
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
        // bd11: user_preferences is a singleton keyed by user_id (always
        // updated, never inserted with a client-chosen id -- see bd19's
        // optimistic-lock update below), so there is no id an Idempotency-Key
        // could double as. The header was validated here but never read
        // again anywhere in this handler; dropped rather than kept as dead
        // validation.
        const parsed = preferencesInputSchema.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) {
          return apiError('INVALID_REQUEST', '설정 값을 확인해 주세요.', 400, currentRequestId, {
            issues: normalizeZodIssues(parsed.error.issues),
          })
        }
        // bd19: every signed-up user gets a user_preferences row at signup
        // (initialize_memdo_user trigger), so this is a real optimistic-lock
        // update, not an upsert -- .eq('updated_at', ...) only matches if
        // nothing else has written since the client's last GET.
        const { data, error } = await context.supabase
          .from('user_preferences')
          .update(preferencesValues(parsed.data))
          .eq('user_id', context.userClaims!.id)
          .eq('updated_at', parsed.data.updatedAt)
          .select('*')
          .maybeSingle()
        if (error) throw error
        if (data) return success(preferencesDto(data), 200, 'preferences.put', 1)

        const current = await context.supabase
          .from('user_preferences')
          .select('*')
          .maybeSingle()
        if (current.error) throw current.error
        if (!current.data) {
          return apiError(
            'RESOURCE_NOT_FOUND',
            '설정을 찾을 수 없습니다. PUT으로 먼저 설정을 저장해 주세요.',
            404,
            currentRequestId,
          )
        }
        return apiError(
          'VERSION_CONFLICT',
          '설정이 다른 곳에서 변경되었습니다.',
          409,
          currentRequestId,
          { currentResource: preferencesDto(current.data) },
        )
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    })
  }),
}
