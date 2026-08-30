import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  type AgentModel,
  agentModelsFromOpenRouter,
  OPENROUTER_MODELS_URL,
} from '../_shared/agent-models-contract.ts'
import { isExperimentalModelSelectable } from '../_shared/model-registry-contract.ts'

const CACHE_TTL_MS = 10 * 60_000
let cache: { models: AgentModel[]; expiresAt: number } | null = null

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()
    if (request.method !== 'GET') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }
    const userId = context.userClaims!.id

    let models: AgentModel[]
    if (cache && cache.expiresAt > Date.now()) {
      models = cache.models
    } else {
      try {
        const response = await fetch(OPENROUTER_MODELS_URL)
        if (!response.ok) throw new Error(`openrouter ${response.status}`)
        models = agentModelsFromOpenRouter(await response.json())
        if (models.length === 0) throw new Error('no allowed tool-capable text models')
        cache = { models, expiresAt: Date.now() + CACHE_TTL_MS }
      } catch (error) {
        if (cache) {
          console.error(JSON.stringify({
            requestId: currentRequestId,
            operation: 'agent_models.refresh',
            error: String(error),
          }))
          models = cache.models
        } else {
          console.error(JSON.stringify({
            requestId: currentRequestId,
            operation: 'agent_models.fetch',
            error: String(error),
          }))
          return apiError(
            'INTERNAL_ERROR',
            '모델 목록을 불러오지 못했습니다.',
            502,
            currentRequestId,
          )
        }
      }
    }

    // be13: this catalog used to list every 'experimental'-tier model to
    // every caller -- agent-cloud-chat already refuses to actually run one
    // for anyone but the allowlisted dev/founder account
    // (isExperimentalModelSelectable), so an ordinary user's picker showed
    // models that would then fail to select. Same gate, applied here too.
    // Filtered per-request, after the cache read/write above, so the
    // shared module-level cache stays one full catalog rather than forking
    // per-user.
    const visibleModels = models.filter((model) =>
      isExperimentalModelSelectable(userId, model.id, undefined, {
        experimentalModelsUserId: Deno.env.get('MEMDO_EXPERIMENTAL_MODELS_USER_ID'),
      })
    )

    const body = { models: visibleModels }
    logRequest({
      eventName: 'agent_models.list',
      requestId: currentRequestId,
      routeTemplate: '/agent-models',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: visibleModels.length,
    })
    return json(body, 200, currentRequestId)
  }),
}
