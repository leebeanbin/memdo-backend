import {
  apiError,
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
