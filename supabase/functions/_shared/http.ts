import { createSupabaseContext } from '@supabase/server'

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_ALLOWED'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'OCCURRENCE_ALREADY_EXISTS'
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

// RATE_LIMITED (429) is the single most retryable error this API produces --
// it was reported as retryable:false purely because `retryable` was derived
// from `status >= 500`, not from what the error actually means (bd8, found
// via founder-dogfooding code review). Derived from the code instead: a
// client backing off and retrying INTERNAL_ERROR/RATE_LIMITED can succeed;
// retrying INVALID_REQUEST/VERSION_CONFLICT/etc. with the same request
// never will.
const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set(['RATE_LIMITED', 'INTERNAL_ERROR'])

// bd24: split out from apiError so agent-cloud-chat's SSE stream can reuse
// the exact same envelope shape for a mid-stream error -- that was the one
// place in the whole API sending a bare `{error: string}`, a different
// contract depending on whether the failure happened before or after the
// stream started.
export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details: Record<string, unknown> = {},
): {
  error: {
    code: ErrorCode
    message: string
    retryable: boolean
    requestId: string
    details: Record<string, unknown>
  }
} {
  return {
    error: { code, message, retryable: RETRYABLE_ERROR_CODES.has(code), requestId, details },
  }
}

export function apiError(
  code: ErrorCode,
  message: string,
  status: number,
  requestId: string,
  details: Record<string, unknown> = {},
): Response {
  return json(errorEnvelope(code, message, requestId, details), status, requestId)
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

// bd25: raw Zod issues (code, path, expected, ...) were passed straight
// into apiError's `details` at ~15 call sites, coupling every client to
// Zod's own internal shape. agent-tool-contract.ts's parseAgentToolCall
// already normalizes to {field,reason} for the model-facing boundary --
// this is the same normalization for the client-facing one. Takes a
// minimal structural type (not zod's own ZodIssue) so this file doesn't
// need a zod import just for validation-error formatting; `path` is typed
// PropertyKey[] (zod's own path element type -- string | number | symbol)
// rather than narrowing it, since none of these schemas ever actually
// produce a symbol path segment but the type still has to accept one.
export function normalizeZodIssues(
  issues: { path: PropertyKey[]; message: string }[],
): { field: string; reason: string }[] {
  return issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    reason: issue.message,
  }))
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// be19: a plain `===`/`!==` comparison of a shared secret against a
// publicly reachable endpoint (google-calendar-sync's cron auth) leaks
// timing information proportional to how many leading bytes match,
// letting an attacker recover the secret byte-by-byte. Web Crypto has no
// timingSafeEqual of its own (SubtleCrypto doesn't expose one) -- rather
// than pull in @types/node just for node:crypto's version, this is the
// same standard XOR-accumulate idiom: every byte is always inspected (the
// `|=` never short-circuits), so the loop's own timing doesn't depend on
// *where* the first differing byte is. The one exception is the length
// check up front, which does exit early on a length mismatch -- the same
// residual length-only leak every timingSafeEqual implementation accepts,
// not something specific to this one.
export function constantTimeEquals(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i]
  }
  return diff === 0
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
