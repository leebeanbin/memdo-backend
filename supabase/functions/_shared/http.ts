export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_ALLOWED'
  | 'FORBIDDEN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
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
