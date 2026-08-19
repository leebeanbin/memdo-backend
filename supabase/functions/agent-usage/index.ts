import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'

type UsageSummaryRow = {
  total_requests: number | string
  total_cost_usd: number | string
  recent: Array<{ model: string; costUsd: number | string; createdAt: string }>
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()
    if (request.method !== 'GET') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const rawDays = new URL(request.url).searchParams.get('days') ?? '30'
    const days = Number(rawDays)
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return apiError(
        'INVALID_REQUEST',
        'days는 1부터 365 사이의 정수여야 합니다.',
        400,
        currentRequestId,
      )
    }

    const { data, error } = await context.supabase
      .rpc('agent_usage_summary', { p_days: days })
      .single()
    if (error) {
      console.error(JSON.stringify({
        requestId: currentRequestId,
        operation: 'agent_usage.summary',
        error,
      }))
      return apiError('INTERNAL_ERROR', '사용량을 불러오지 못했습니다.', 500, currentRequestId)
    }

    const row = data as UsageSummaryRow
    const body = {
      totalRequests: Number(row.total_requests),
      totalCostUsd: Number(row.total_cost_usd),
      recent: (row.recent ?? []).map((item) => ({
        model: item.model,
        costUsd: Number(item.costUsd),
        createdAt: item.createdAt,
      })),
    }
    logRequest({
      eventName: 'agent_usage.summary',
      requestId: currentRequestId,
      routeTemplate: '/agent-usage',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: body.recent.length,
    })
    return json(body, 200, currentRequestId)
  }),
}
