import {
  apiError,
  constantTimeEquals,
  errorEnvelope,
  normalizeZodIssues,
  POSTGRES_FOREIGN_KEY_VIOLATION,
  POSTGRES_UNIQUE_VIOLATION,
  successResponder,
  withCrudErrors,
} from './http.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('POSTGRES_UNIQUE_VIOLATION and POSTGRES_FOREIGN_KEY_VIOLATION are the real Postgres codes', () => {
  // Not just "some string" -- these are checked against real error.code
  // values from Supabase, so a typo here would silently stop every
  // idempotency-replay/FK-violation branch across todos/rules/workout-logs
  // from ever matching.
  assert(POSTGRES_UNIQUE_VIOLATION === '23505')
  assert(POSTGRES_FOREIGN_KEY_VIOLATION === '23503')
})

Deno.test('successResponder returns the exact body/status it was given', async () => {
  const respond = successResponder({
    request: new Request('https://example.com/todos'),
    currentRequestId: 'req-1',
    routeTemplate: '/todos',
    startedAt: performance.now(),
  })
  const response = respond({ id: 'abc' }, 201, 'todos.create', 1)
  assert(response.status === 201)
  assert(response.headers.get('X-Request-ID') === 'req-1')
  const body = await response.json()
  assert(body.id === 'abc')
})

Deno.test('successResponder threads a different status through per call, not fixed at construction', async () => {
  // Every pre-refactor `success` closure this replaces took `status` per
  // call (or, for reviews/preferences, hard-coded 200) -- this pins that a
  // single responder instance still varies per call rather than baking in
  // whatever the first call used.
  const respond = successResponder({
    request: new Request('https://example.com/todos'),
    currentRequestId: 'req-1',
    routeTemplate: '/todos',
    startedAt: performance.now(),
  })
  const created = respond({ id: 'a' }, 201, 'todos.create', 1)
  const listed = respond({ items: [] }, 200, 'todos.list', 0)
  assert(created.status === 201)
  assert(listed.status === 200)
})

Deno.test('withCrudErrors returns the route handler result unchanged on success', async () => {
  const response = await withCrudErrors('todos', 'req-1', async () => {
    return apiError('RESOURCE_NOT_FOUND', 'not found', 404, 'req-1')
  })
  assert(response.status === 404)
})

Deno.test('withCrudErrors catches a thrown error and returns INTERNAL_ERROR instead of propagating', async () => {
  const response = await withCrudErrors('todos', 'req-1', async () => {
    throw new Error('boom')
  })
  assert(response.status === 500)
  const body = await response.json()
  assert(body.error.code === 'INTERNAL_ERROR')
  assert(body.error.requestId === 'req-1')
})

Deno.test('apiError marks RATE_LIMITED as retryable even though its status is 4xx', async () => {
  // bd8: retryable used to be derived from `status >= 500` -- RATE_LIMITED
  // is the single most retryable error this API produces (back off, try
  // again) and was reported as retryable:false purely because 429 < 500.
  const body = await apiError('RATE_LIMITED', 'too many', 429, 'req-1').json()
  assert(body.error.retryable === true)
})

Deno.test('apiError marks INTERNAL_ERROR as retryable', async () => {
  const body = await apiError('INTERNAL_ERROR', 'oops', 500, 'req-1').json()
  assert(body.error.retryable === true)
})

Deno.test('apiError marks a real 4xx client error as not retryable', async () => {
  const versionConflict = await apiError('VERSION_CONFLICT', 'stale', 409, 'req-1').json()
  const invalidRequest = await apiError('INVALID_REQUEST', 'bad', 400, 'req-1').json()
  assert(versionConflict.error.retryable === false)
  assert(invalidRequest.error.retryable === false)
})

Deno.test('errorEnvelope produces the exact body apiError wraps in a Response', () => {
  // bd24: this is what agent-cloud-chat's SSE stream sends directly (no
  // Response involved) -- pins that it's the same shape apiError uses.
  const envelope = errorEnvelope('INTERNAL_ERROR', 'Agent 응답을 받지 못했습니다.', 'req-1')
  assert(envelope.error.code === 'INTERNAL_ERROR')
  assert(envelope.error.message === 'Agent 응답을 받지 못했습니다.')
  assert(envelope.error.retryable === true)
  assert(envelope.error.requestId === 'req-1')
})

Deno.test('normalizeZodIssues maps path/message into field/reason', () => {
  // bd25: the shape every ~15 call sites now send instead of a raw
  // ZodIssue array (code, path, expected, ...).
  const normalized = normalizeZodIssues([
    { path: ['title'], message: 'Required' },
    { path: ['location', 'latitude'], message: 'Expected number, received string' },
  ])
  assert(normalized.length === 2)
  assert(normalized[0].field === 'title')
  assert(normalized[0].reason === 'Required')
  assert(normalized[1].field === 'location.latitude')
})

Deno.test('normalizeZodIssues falls back to (root) for a root-level issue', () => {
  const normalized = normalizeZodIssues([{ path: [], message: 'Invalid input' }])
  assert(normalized[0].field === '(root)')
})

Deno.test('constantTimeEquals matches on equal strings and rejects unequal ones', () => {
  // be19: pins the actual comparison result, not the timing property
  // itself (a real timing-side-channel test isn't practical in a unit
  // test) -- the point under test is that this replaces `===` correctly,
  // not that it's provably constant-time.
  assert(constantTimeEquals('Bearer secret-token', 'Bearer secret-token') === true)
  assert(constantTimeEquals('Bearer secret-token', 'Bearer wrong-token!!') === false)
})

Deno.test('constantTimeEquals rejects a length mismatch without throwing', () => {
  assert(constantTimeEquals('short', 'a much longer string') === false)
  assert(constantTimeEquals('', 'nonempty') === false)
  assert(constantTimeEquals('', '') === true)
})
