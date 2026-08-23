// Agent Domain Fixture Contract: v1
import { freeSlotsInWindow, type TimeRange } from './free-slot-service.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

// Fixed reference day, plain UTC clock times -- freeSlotsInWindow does no
// timezone math of its own (that's the caller's job, e.g. timeOn() in
// agent-cloud-contract.ts), so bare UTC instants are fine here.
function at(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(2026, 7, 16, h, m))
}

function range(startHHmm: string, endHHmm: string): TimeRange {
  return { start: at(startHHmm), end: at(endHHmm) }
}

function assertSlots(actual: TimeRange[], expected: Array<[string, string]>) {
  assert(actual.length === expected.length)
  actual.forEach((slot, i) => {
    assert(slot.start.getTime() === at(expected[i][0]).getTime())
    assert(slot.end.getTime() === at(expected[i][1]).getTime())
  })
}

const HOUR = 3_600_000

Deno.test('free-slot/no-busy', () => {
  const slots = freeSlotsInWindow([], at('09:00'), at('18:00'), HOUR)
  assertSlots(slots, [['09:00', '10:00']])
})

Deno.test('free-slot/single-gap-fits', () => {
  const slots = freeSlotsInWindow([range('10:00', '11:00')], at('09:00'), at('18:00'), HOUR)
  assertSlots(slots, [['09:00', '10:00'], ['11:00', '12:00']])
})

Deno.test('free-slot/gap-too-small', () => {
  const busy = [range('09:30', '10:30'), range('10:45', '18:00')]
  const slots = freeSlotsInWindow(busy, at('09:00'), at('18:00'), HOUR)
  assert(slots.length === 0)
})

Deno.test('free-slot/back-to-back-busy', () => {
  const busy = [range('09:00', '12:00'), range('12:00', '15:00')]
  const slots = freeSlotsInWindow(busy, at('09:00'), at('18:00'), HOUR)
  assertSlots(slots, [['15:00', '16:00']])
})

Deno.test('free-slot/more-than-max-results', () => {
  const busy = [
    range('10:00', '10:05'),
    range('11:05', '11:10'),
    range('12:10', '12:15'),
    range('13:15', '13:20'),
    range('14:20', '14:25'),
  ]
  const slots = freeSlotsInWindow(busy, at('09:00'), at('18:00'), HOUR)
  assertSlots(slots, [['09:00', '10:00'], ['10:05', '11:05'], ['11:10', '12:10']])
})

Deno.test('free-slot/invalid-busy-range', () => {
  // 10:00-09:00 is reversed (end < start), 11:00-11:00 has zero length --
  // both must be ignored, as if there were no busy ranges at all.
  const busy = [range('10:00', '09:00'), range('11:00', '11:00')]
  const slots = freeSlotsInWindow(busy, at('09:00'), at('18:00'), HOUR)
  assertSlots(slots, [['09:00', '10:00']])
})

Deno.test('free-slot/invalid-window', () => {
  const slots = freeSlotsInWindow([], at('18:00'), at('09:00'), HOUR)
  assert(slots.length === 0)
})

Deno.test('free-slot/busy-after-window', () => {
  // Without clipping, this busy range would be misread as "the 09:00-10:00
  // window is entirely free" and produce a candidate extending past 10:00.
  const slots = freeSlotsInWindow([range('12:00', '13:00')], at('09:00'), at('10:00'), 2 * HOUR)
  assert(slots.length === 0)
})

Deno.test('free-slot/busy-spans-window-start', () => {
  // Busy starts before the window and straddles into it -- only the part
  // inside [windowStart, windowEnd) should block candidates.
  const slots = freeSlotsInWindow([range('08:00', '10:00')], at('09:00'), at('12:00'), HOUR)
  assertSlots(slots, [['10:00', '11:00']])
})

Deno.test('freeSlotsInWindow returns [] for a non-positive duration', () => {
  const slots = freeSlotsInWindow([], at('09:00'), at('18:00'), 0)
  assert(slots.length === 0)
})

Deno.test('freeSlotsInWindow returns [] for a non-positive maxResults', () => {
  const slots = freeSlotsInWindow([], at('09:00'), at('18:00'), HOUR, 0)
  assert(slots.length === 0)
})
