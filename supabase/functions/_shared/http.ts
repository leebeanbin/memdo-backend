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

// Postgres error codes callers check against `error.code` after a Supabase
// write, most often to distinguish an idempotency-key replay (unique
// violation on a client-supplied id) from a real failure, or a dangling
// foreign key reference from something worth a 500. Named so a reader
// doesn't need PostgreSQL's numeric error-code table memorized.
export const POSTGRES_UNIQUE_VIOLATION = '23505'
export const POSTGRES_FOREIGN_KEY_VIOLATION = '23503'

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

export type SuccessResponder = (
  body: unknown,
  status: number,
  eventName: string,
  returnedRows: number,
) => Response

/** Every CRUD route handler declared its own identical `success` closure
 * (log then respond) -- four slightly different signatures had drifted in
 * across todos/rules/categories/reviews/preferences/agent-key before this.
 * One factory, one signature (body, status, eventName, returnedRows) for
 * every caller. */
export function successResponder(
  opts: { request: Request; currentRequestId: string; routeTemplate: string; startedAt: number },
): SuccessResponder {
  return (body, status, eventName, returnedRows) => {
    logRequest({
      eventName,
      requestId: opts.currentRequestId,
      routeTemplate: opts.routeTemplate,
      method: opts.request.method,
      status,
      durationMs: performance.now() - opts.startedAt,
      responseBytes: responseByteLength(body),
      returnedRows,
    })
    return json(body, status, opts.currentRequestId)
  }
}

/** The `try { ...routes... } catch (error) { log; return INTERNAL_ERROR }`
 * wrapper every CRUD route handler re-implemented identically (same log
 * shape, same fallback message). `operation` becomes the logged operation
 * name so a caught error is still attributable to its route. */
export async function withCrudErrors(
  operation: string,
  currentRequestId: string,
  routes: () => Promise<Response>,
): Promise<Response> {
  try {
    return await routes()
  } catch (error) {
    console.error(JSON.stringify({ requestId: currentRequestId, operation, error }))
    return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
  }
}
