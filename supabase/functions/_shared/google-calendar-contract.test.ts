import {
  classifyGoogleCalendarErrorReason,
  isMemdoAuthoredEvent,
  mapGoogleEventToMirrorRow,
  MEMDO_KIND_PROPERTY,
  MEMDO_TODO_ID_PROPERTY,
  memdoTodoIdFromEvent,
  plainTextFromGoogleDescription,
  toGoogleEventBody,
} from './google-calendar-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
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

// toGoogleEventBody / all-day exclusive end-date -- the single easiest-to-get-
// backwards piece of the whole push feature (Google's own convention: a
// single-day all-day event's end.date is the day AFTER start.date).

Deno.test('toGoogleEventBody pushes a task as a single-day all-day event with an exclusive end.date', () => {
  const body = toGoogleEventBody({
    id: 'todo-1',
    title: '30분 산책',
    entry_kind: 'task',
    is_all_day: false,
    scheduled_date: '2026-09-05',
    start_at: null,
    end_at: null,
    note: null,
    location_name: null,
  })
  assertEquals(body.start.date, '2026-09-05')
  assertEquals(body.end.date, '2026-09-06')
  assertEquals(body.start.dateTime, undefined)
})

Deno.test('toGoogleEventBody exclusive end-date rolls over a month/year boundary correctly', () => {
  const body = toGoogleEventBody({
    id: 'todo-2',
    title: '연말 정리',
    entry_kind: 'task',
    is_all_day: false,
    scheduled_date: '2026-12-31',
    start_at: null,
    end_at: null,
    note: null,
    location_name: null,
  })
  assertEquals(body.start.date, '2026-12-31')
  assertEquals(body.end.date, '2027-01-01')
})

Deno.test('toGoogleEventBody pushes a timed event with real start/end dateTime, not all-day', () => {
  const body = toGoogleEventBody({
    id: 'todo-3',
    title: '팀 회의',
    entry_kind: 'event',
    is_all_day: false,
    scheduled_date: '2026-09-05',
    start_at: '2026-09-05T09:00:00Z',
    end_at: '2026-09-05T10:00:00Z',
    note: null,
    location_name: null,
  })
  assertEquals(body.start.dateTime, '2026-09-05T09:00:00Z')
  assertEquals(body.end.dateTime, '2026-09-05T10:00:00Z')
  assertEquals(body.start.date, undefined)
})

Deno.test('toGoogleEventBody tags every pushed event with memdoTodoId/memdoKind', () => {
  const body = toGoogleEventBody({
    id: 'todo-4',
    title: '아무 일정',
    entry_kind: 'task',
    is_all_day: false,
    scheduled_date: '2026-09-05',
    start_at: null,
    end_at: null,
    note: null,
    location_name: null,
  })
  assertEquals(body.extendedProperties.private[MEMDO_TODO_ID_PROPERTY], 'todo-4')
  assertEquals(body.extendedProperties.private[MEMDO_KIND_PROPERTY], 'task')
})

// isMemdoAuthoredEvent / memdoTodoIdFromEvent -- the echo-loop-prevention
// check the pull side depends on to never re-mirror an event Memdo itself
// pushed.

Deno.test('isMemdoAuthoredEvent is true only when the memdoTodoId private property is present', () => {
  assert(
    isMemdoAuthoredEvent({
      id: 'g1',
      status: 'confirmed',
      extendedProperties: { private: { [MEMDO_TODO_ID_PROPERTY]: 'todo-1' } },
    }),
  )
  assert(!isMemdoAuthoredEvent({ id: 'g2', status: 'confirmed' }))
  assert(!isMemdoAuthoredEvent({ id: 'g3', status: 'confirmed', extendedProperties: {} }))
  assert(
    !isMemdoAuthoredEvent({
      id: 'g4',
      status: 'confirmed',
      extendedProperties: { private: { someOtherApp: 'x' } },
    }),
  )
})

Deno.test('memdoTodoIdFromEvent extracts the tagged todo id, or null when absent', () => {
  assertEquals(
    memdoTodoIdFromEvent({
      id: 'g1',
      status: 'confirmed',
      extendedProperties: { private: { [MEMDO_TODO_ID_PROPERTY]: 'todo-7' } },
    }),
    'todo-7',
  )
  assertEquals(memdoTodoIdFromEvent({ id: 'g2', status: 'confirmed' }), null)
})

// plainTextFromGoogleDescription -- Google Calendar's own rich-text editor
// emits HTML descriptions; Memdo's memo field doesn't render HTML, so this
// must come out as clean plain text, not raw markup.

Deno.test('plainTextFromGoogleDescription strips paragraph tags and decodes entities (real Calendar output)', () => {
  const html =
    '<p>오늘 체크리스트: https://docs.google.com/spreadsheets/d/1v7PKmpy9Xe-BuWybR_Wv9p-XDQpu3TRU7hONNkG2LyE/edit#gid=1608798922&amp;range=A2:N2</p>\n' +
    '<p>필수 3개(강의·학습 / 실습·복기 / 시험 공부·회고)를 모두 체크하면 완료입니다.\n기본 120분, 선택 확장 60분으로 최대 180분입니다.</p>'
  const text = plainTextFromGoogleDescription(html)
  assert(!text.includes('<p>'))
  assert(!text.includes('</p>'))
  assert(!text.includes('&amp;'))
  assert(
    text.includes(
      '오늘 체크리스트: https://docs.google.com/spreadsheets/d/1v7PKmpy9Xe-BuWybR_Wv9p-XDQpu3TRU7hONNkG2LyE/edit#gid=1608798922&range=A2:N2',
    ),
  )
  assert(
    text.includes('필수 3개(강의·학습 / 실습·복기 / 시험 공부·회고)를 모두 체크하면 완료입니다.'),
  )
})

Deno.test('plainTextFromGoogleDescription converts <br> to a newline and strips inline formatting tags', () => {
  const text = plainTextFromGoogleDescription(
    '<b>중요</b><br>두 번째 줄 <a href="https://x.com">링크</a>',
  )
  assertEquals(text, '중요\n두 번째 줄 링크')
})

Deno.test('plainTextFromGoogleDescription leaves plain (non-HTML) text untouched', () => {
  assertEquals(plainTextFromGoogleDescription('그냥 평문 메모'), '그냥 평문 메모')
})

Deno.test('mapGoogleEventToMirrorRow stores the plain-text-converted note, not raw HTML', () => {
  const row = mapGoogleEventToMirrorRow(
    {
      id: 'g1',
      status: 'confirmed',
      summary: '팀 스탠드업',
      description: '<p>어제 진행 상황 공유</p>',
      start: { dateTime: '2026-09-05T09:00:00Z' },
      end: { dateTime: '2026-09-05T09:15:00Z' },
      updated: '2026-09-01T00:00:00Z',
    },
    'conn-1',
    'user-1',
  )
  assertEquals(row?.note, '어제 진행 상황 공유')
})
