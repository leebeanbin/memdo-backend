import { createSupabaseContext } from '@supabase/server'

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_ALLOWED'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'

export function requestId(request: Request): string {
  return request.headers.get('X-Request-ID') ?? crypto.randomUUID()
}

export function json(body: unknown, status: number, requestId: string): Response {
  return Response.json(body, {
    status,
    headers: { 'X-Request-ID': requestId },
  })
}

export function apiError(
  code: ErrorCode,
  message: string,
  status: number,
  requestId: string,
  details: Record<string, unknown> = {},
): Response {
  return json(
    { error: { code, message, retryable: status >= 500, requestId, details } },
    status,
    requestId,
  )
}

/**
 * Wraps a request handler with user auth and a uniform error envelope.
 *
 * `withSupabase` from `@supabase/server` returns auth failures as a bare
 * `{ message, code }` body with no `error` wrapper, no `retryable`, and no
 * X-Request-ID header — off-contract relative to `apiError`/`json` above — and
 * it does not catch throws from the handler itself. This closes both gaps by
 * calling `createSupabaseContext` directly and handling both cases here.
 */
export function withApi<T = unknown>(
  handler: (request: Request, context: T, currentRequestId: string) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const currentRequestId = requestId(request)
    const { data: context, error } = await createSupabaseContext(request, { auth: 'user' })
    if (error) {
      return apiError(
        error.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR',
        '인증이 필요합니다.',
        error.status,
        currentRequestId,
      )
    }
    try {
      return await handler(request, context as T, currentRequestId)
    } catch (thrown) {
      console.error(JSON.stringify({ requestId: currentRequestId, error: String(thrown) }))
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
  }
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function responseByteLength(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength
}

export function logRequest(event: {
  eventName: string
  requestId: string
  routeTemplate: string
  method: string
  status: number
  durationMs: number
  responseBytes: number
  returnedRows: number
}): void {
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'memdo-api',
    ...event,
    durationMs: Math.round(event.durationMs * 100) / 100,
  }))
}
