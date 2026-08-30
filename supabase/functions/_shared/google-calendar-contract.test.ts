import { classifyGoogleCalendarErrorReason } from './google-calendar-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('classifyGoogleCalendarErrorReason maps a null message to unknown', () => {
  assert(classifyGoogleCalendarErrorReason(null) === 'unknown')
})

Deno.test('classifyGoogleCalendarErrorReason maps invalid_grant to auth_expired', () => {
  assert(
    classifyGoogleCalendarErrorReason(
      'google token refresh failed: 400 {"error":"invalid_grant"}',
    ) ===
      'auth_expired',
  )
})

Deno.test('classifyGoogleCalendarErrorReason maps a missing refresh token secret to auth_expired', () => {
  assert(classifyGoogleCalendarErrorReason('missing refresh token secret') === 'auth_expired')
})

Deno.test('classifyGoogleCalendarErrorReason maps an upstream 401 to auth_expired', () => {
  assert(
    classifyGoogleCalendarErrorReason('google events.list failed: 401 unauthorized') ===
      'auth_expired',
  )
})

Deno.test('classifyGoogleCalendarErrorReason maps an upstream 429 to rate_limited', () => {
  assert(
    classifyGoogleCalendarErrorReason('google events.list failed: 429 too many requests') ===
      'rate_limited',
  )
})

Deno.test('classifyGoogleCalendarErrorReason maps an upstream 404 to calendar_not_found', () => {
  assert(
    classifyGoogleCalendarErrorReason('google events.list failed: 404 not found') ===
      'calendar_not_found',
  )
})

Deno.test('classifyGoogleCalendarErrorReason never leaks the raw message text back out', () => {
  // The whole point of be12: no matter what upstream sends, the return
  // value is always one of the closed enum members.
  const reasons = new Set([
    'auth_expired',
    'rate_limited',
    'calendar_not_found',
    'unknown',
  ])
  const raw = 'some unexpected upstream failure: 500 internal server error <html>...</html>'
  assert(reasons.has(classifyGoogleCalendarErrorReason(raw)))
})
