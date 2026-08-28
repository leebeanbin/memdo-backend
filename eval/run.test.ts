import { gradeCase } from './grade.ts'
import { MissingDebugTraceError, runFixture } from './run.ts'

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message)
}

async function assertThrows(
  fn: () => Promise<unknown>,
  errorClass: new (...args: never[]) => Error,
) {
  try {
    await fn()
  } catch (error) {
    assert(
      error instanceof errorClass,
      `expected ${errorClass.name}, got ${
        error instanceof Error ? error.constructor.name : String(error)
      }`,
    )
    return
  }
  throw new Error(`expected ${errorClass.name} to be thrown, but nothing was thrown`)
}

const OPTS = { baseUrl: 'https://x', publishableKey: 'k', accessToken: 't', model: 'm' }

/** Stubs global fetch for the duration of `fn`, returning a streamed NDJSON
 * response built from `lines` -- mirrors agent-cloud-chat's actual
 * line-delimited stream shape closely enough for runFixture's reader loop. */
async function withStreamedResponse<T>(lines: string[], fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (() => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line + '\n'))
        controller.close()
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

Deno.test('runFixture: missing debugTrace entirely fails closed', async () => {
  await withStreamedResponse(
    [JSON.stringify({ done: true, toolNames: [] })],
    () =>
      assertThrows(
        () =>
          runFixture({ id: 'f-1', category: 'x', input: 'hi', expectedBehavior: 'ANSWER' }, OPTS),
        MissingDebugTraceError,
      ),
  )
})

Deno.test('runFixture: a streamed {error} line throws immediately, never grades as no-tool-called', async () => {
  await withStreamedResponse(
    [JSON.stringify({ error: 'OpenRouter 요청에 실패했어요.' })],
    async () => {
      try {
        await runFixture(
          { id: 'f-err', category: 'x', input: 'hi', expectedBehavior: 'ANSWER' },
          OPTS,
        )
      } catch (error) {
        assert(error instanceof Error, 'expected an Error to be thrown')
        assert(
          String((error as Error).message).includes('OpenRouter 요청에 실패했어요.'),
          `expected the thrown error to include the streamed error text, got: ${
            (error as Error).message
          }`,
        )
        return
      }
      throw new Error('expected runFixture to throw on a streamed {error} line, but it did not')
    },
  )
})

Deno.test('runFixture: EOF without any done line fails closed', async () => {
  await withStreamedResponse(
    [JSON.stringify({ delta: 'partial only, stream just ends' })],
    () =>
      assertThrows(
        () =>
          runFixture(
            { id: 'f-eof', category: 'x', input: 'hi', expectedBehavior: 'ANSWER' },
            OPTS,
          ),
        MissingDebugTraceError,
      ),
  )
})

Deno.test('runFixture: a malformed toolCalls entry fails closed rather than grading normally', async () => {
  await withStreamedResponse(
    [
      JSON.stringify({
        done: true,
        toolNames: ['find_free_slots'],
        debugTrace: {
          requestedModel: 'm',
          resolvedModel: 'm',
          latencyMs: 1,
          // Missing `args` -- not a valid DispatchedTool entry.
          toolCalls: [{ name: 'find_free_slots' }],
        },
      }),
    ],
    () =>
      assertThrows(
        () =>
          runFixture(
            { id: 'f-malformed', category: 'x', input: 'hi', expectedBehavior: 'FIND_FREE_SLOTS' },
            OPTS,
          ),
        MissingDebugTraceError,
      ),
  )
})

Deno.test('runFixture: debugTrace present but toolCalls malformed fails closed', async () => {
  await withStreamedResponse(
    [JSON.stringify({
      done: true,
      toolNames: [],
      debugTrace: { requestedModel: 'm', resolvedModel: 'm', latencyMs: 1 },
    })],
    () =>
      assertThrows(
        () =>
          runFixture({ id: 'f-2', category: 'x', input: 'hi', expectedBehavior: 'ANSWER' }, OPTS),
        MissingDebugTraceError,
      ),
  )
})

Deno.test('runFixture: explicitly empty toolCalls is valid, not an error -- reaches gradeCase as a pass for ANSWER-shaped fixtures once graded manually', async () => {
  const fixture = { id: 'f-3', category: 'x', input: 'hi', expectedBehavior: 'ANSWER' as const }
  const actual = await withStreamedResponse(
    [
      JSON.stringify({
        done: true,
        toolNames: [],
        debugTrace: { requestedModel: 'm', resolvedModel: 'm', latencyMs: 1, toolCalls: [] },
      }),
    ],
    () => runFixture(fixture, OPTS),
  )
  assert(Array.isArray(actual.dispatchedTools) && actual.dispatchedTools.length === 0)
  const graded = gradeCase(fixture, actual)
  assert(graded.verdict === 'manual-review', `expected manual-review, got ${graded.verdict}`)
})

Deno.test('runFixture: a valid sanitized debugTrace.toolCalls reaches gradeCase and can pass', async () => {
  const fixture = {
    id: 'f-4',
    category: 'x',
    input: '오늘 빈 시간 알려줘',
    expectedBehavior: 'FIND_FREE_SLOTS' as const,
    expected: { scope: 'today' },
  }
  const actual = await withStreamedResponse(
    [
      JSON.stringify({ delta: 'partial' }),
      JSON.stringify({
        done: true,
        toolNames: ['find_free_slots'],
        debugTrace: {
          requestedModel: 'm',
          resolvedModel: 'm',
          latencyMs: 5,
          toolCalls: [{ name: 'find_free_slots', args: { scope: 'today' } }],
        },
      }),
    ],
    () => runFixture(fixture, OPTS),
  )
  const graded = gradeCase(fixture, actual)
  assert(graded.verdict === 'pass', `expected pass, got ${graded.verdict}: ${graded.reason}`)
})

Deno.test('runFixture: grading needs only the normalized args grade.ts checks -- no narrative/raw field is required', async () => {
  // This tool call's args carry exactly the normalized fields the corpus's
  // `expected` blocks ever pin down (see eval/agent-v0/*.jsonl) -- no
  // title/note/reflection/question field is present at all, proving those
  // were never necessary for grading to reach a verdict.
  const fixture = {
    id: 'f-5',
    category: 'x',
    input: '내일 9시에 회의 잡아줘',
    expectedBehavior: 'PROPOSE_SCHEDULE' as const,
    expected: { date: 'tomorrow', startTime: '09:00', isTask: false },
  }
  const actual = await withStreamedResponse(
    [
      JSON.stringify({
        done: true,
        toolNames: ['propose_schedule'],
        debugTrace: {
          requestedModel: 'm',
          resolvedModel: 'm',
          latencyMs: 5,
          toolCalls: [
            {
              name: 'propose_schedule',
              args: { date: 'tomorrow', startTime: '09:00', isTask: false },
            },
          ],
        },
      }),
    ],
    () => runFixture(fixture, OPTS),
  )
  const graded = gradeCase(fixture, actual)
  assert(graded.verdict === 'pass', `expected pass, got ${graded.verdict}: ${graded.reason}`)
})
