import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import { agentKeySaveSchema, OPENROUTER_PROVIDER } from '../_shared/agent-key-contract.ts'
import { serviceClient } from '../_shared/google-calendar-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()
    const userId = context.userClaims!.id
    const supabase = serviceClient()

    const success = (body: unknown, status: number, eventName: string) => {
      logRequest({
        eventName,
        requestId: currentRequestId,
        routeTemplate: '/agent-key',
        method: request.method,
        status,
        durationMs: performance.now() - startedAt,
        responseBytes: responseByteLength(body),
        returnedRows: 0,
      })
      return json(body, status, currentRequestId)
    }

    if (request.method === 'GET') {
      const { data, error } = await supabase
        .from('user_api_keys')
        .select('provider')
        .eq('user_id', userId)
        .eq('provider', OPENROUTER_PROVIDER)
        .maybeSingle()
      if (error) {
        console.error(
          JSON.stringify({ requestId: currentRequestId, operation: 'agent_key.status', error }),
        )
        return apiError('INTERNAL_ERROR', '연결 상태를 확인하지 못했습니다.', 500, currentRequestId)
      }
      return success({ connected: data !== null }, 200, 'agent_key.status')
    }

    if (request.method === 'PUT') {
      const parsed = agentKeySaveSchema.safeParse(await request.json().catch(() => undefined))
      if (!parsed.success) {
        return apiError('INVALID_REQUEST', 'API 키를 확인해 주세요.', 400, currentRequestId, {
          issues: parsed.error.issues,
        })
      }

      try {
        const { data: existing, error: findError } = await supabase
          .from('user_api_keys')
          .select('id,secret_id')
          .eq('user_id', userId)
          .eq('provider', OPENROUTER_PROVIDER)
          .maybeSingle()
        if (findError) throw findError

        if (existing) {
          const { error: updateSecretError } = await supabase.rpc('vault_update_secret', {
            p_id: existing.secret_id,
            p_secret: parsed.data.apiKey,
          })
          if (updateSecretError) throw updateSecretError
        } else {
          const { data: secretId, error: createSecretError } = await supabase.rpc(
            'vault_create_secret',
            {
              p_secret: parsed.data.apiKey,
              p_name: `agent_key:${OPENROUTER_PROVIDER}:${userId}:${crypto.randomUUID()}`,
            },
          )
          if (createSecretError) throw createSecretError

          const inserted = await supabase.from('user_api_keys').insert({
            user_id: userId,
            provider: OPENROUTER_PROVIDER,
            secret_id: secretId,
          })
          if (inserted.error) throw inserted.error
        }
      } catch (error) {
        console.error(
          JSON.stringify({ requestId: currentRequestId, operation: 'agent_key.save', error }),
        )
        return apiError('INTERNAL_ERROR', 'API 키를 저장하지 못했습니다.', 500, currentRequestId)
      }

      return success({ connected: true }, 200, 'agent_key.save')
    }

    if (request.method === 'DELETE') {
      const { data: existing, error: findError } = await supabase
        .from('user_api_keys')
        .select('id,secret_id')
        .eq('user_id', userId)
        .eq('provider', OPENROUTER_PROVIDER)
        .maybeSingle()
      if (findError) {
        console.error(
          JSON.stringify({
            requestId: currentRequestId,
            operation: 'agent_key.delete',
            error: findError,
          }),
        )
        return apiError('INTERNAL_ERROR', '연결 해지에 실패했습니다.', 500, currentRequestId)
      }

      if (existing) {
        const deleted = await supabase.from('user_api_keys').delete().eq('id', existing.id)
        if (deleted.error) {
          console.error(
            JSON.stringify({
              requestId: currentRequestId,
              operation: 'agent_key.delete',
              error: deleted.error,
            }),
          )
          return apiError('INTERNAL_ERROR', '연결 해지에 실패했습니다.', 500, currentRequestId)
        }
        try {
          await supabase.rpc('vault_delete_secret', { p_id: existing.secret_id })
        } catch (cleanupError) {
          console.error(
            JSON.stringify({
              requestId: currentRequestId,
              operation: 'agent_key.delete.cleanup',
              error: String(cleanupError),
            }),
          )
        }
      }

      return success({ connected: false }, 200, 'agent_key.delete')
    }

    return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
  }),
}
