import { apiError, requestId as extractRequestId, withApi } from '../_shared/http.ts'
import {
  accumulatedToolCallsArray,
  applyStreamChunk,
  chatRequestSchema,
  cloudAgentTools,
  DEFAULT_OPENROUTER_MODEL,
  type ExistingScheduleRow,
  expandScope,
  findConflict,
  formatSlot,
  MAX_TOOL_ITERATIONS,
  newStreamAccumulator,
  OPENROUTER_CHAT_URL,
  parseStreamLine,
  type ProposedScheduleArgs,
  RATE_LIMIT_PER_HOUR,
  resolveDate,
  type StreamAccumulator,
  systemPrompt,
  timeOn,
  toISODate,
} from '../_shared/agent-cloud-contract.ts'
import { OPENROUTER_PROVIDER } from '../_shared/agent-key-contract.ts'
import { serviceClient } from '../_shared/google-calendar-contract.ts'

type ChatMessage = {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

async function fetchSchedules(
  supabase: { from: (table: string) => any },
  from: string,
  to: string,
): Promise<ExistingScheduleRow[]> {
  const { data, error } = await supabase
    .from('todos')
    .select('title,scheduled_date,start_at,end_at')
    .is('deleted_at', null)
    .gte('scheduled_date', from)
    .lte('scheduled_date', to)
    .limit(200)
  if (error) throw error
  return data as ExistingScheduleRow[]
}

async function searchSchedules(
  supabase: { from: (table: string) => any },
  args: { from?: string; to?: string },
): Promise<unknown> {
  if (!args.from || !args.to) return { error: 'from and to are required' }
  try {
    const rows = await fetchSchedules(supabase, args.from, args.to)
    return {
      items: rows.map((r) => ({
        title: r.title,
        scheduledDate: r.scheduled_date,
        startAt: r.start_at,
        endAt: r.end_at,
      })),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function findFreeSlots(
  supabase: { from: (table: string) => any },
  args: { scope?: string; durationMinutes?: number; windowStart?: string; windowEnd?: string },
): Promise<unknown> {
  const dates = expandScope(args.scope ?? 'today')
  const duration = Math.max(15, args.durationMinutes ?? 30) * 60_000
  const from = dates[0]
  const to = dates.at(-1) ?? dates[0]

  let rows: ExistingScheduleRow[]
  try {
    rows = await fetchSchedules(supabase, from, to)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const busy = rows.filter((row) => row.start_at && row.end_at)

  const lines: string[] = []
  for (const date of dates) {
    const dayBusy = busy
      .filter((row) => row.scheduled_date === date)
      .map((row) => ({ start: new Date(row.start_at!), end: new Date(row.end_at!) }))
      .sort((a, b) => a.start.getTime() - b.start.getTime())

    const windowStart = timeOn(date, args.windowStart) ?? timeOn(date, '08:00')!
    const windowEnd = timeOn(date, args.windowEnd) ?? timeOn(date, '22:00')!

    const slots: string[] = []
    let cursor = windowStart
    for (const range of dayBusy) {
      if (range.start.getTime() > cursor.getTime()) {
        if (range.start.getTime() - cursor.getTime() >= duration) {
          slots.push(formatSlot(cursor, new Date(cursor.getTime() + duration)))
        }
      }
      if (range.end.getTime() > cursor.getTime()) cursor = range.end
    }
    if (windowEnd.getTime() - cursor.getTime() >= duration) {
      slots.push(formatSlot(cursor, new Date(cursor.getTime() + duration)))
    }
    if (slots.length > 0) lines.push(`${date}: ${slots.slice(0, 3).join(', ')}`)
  }

  return { slots: lines }
}

/** Streams one OpenRouter chat-completions call and accumulates the result.
 * `onContent`, if given, fires live as content deltas arrive -- content and
 * tool_calls never appear in the same turn for OpenAI-compatible providers,
 * so it's safe to wire this unconditionally on every iteration: it simply
 * never fires during a tool-calling turn, and fires in real time during
 * whichever turn ends up being the final text answer, without needing to
 * know in advance which turn that'll be. */
async function callOpenRouterStreamed(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onContent?: (chunk: string) => void,
): Promise<StreamAccumulator> {
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, tools: cloudAgentTools, stream: true }),
  })
  if (!response.ok || !response.body) {
    throw new Error(`openrouter ${response.status}: ${await response.text().catch(() => '')}`)
  }

  const acc = newStreamAccumulator()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const chunk = parseStreamLine(line)
        if (!chunk) continue
        applyStreamChunk(acc, chunk)
        if (chunk.content && onContent) onContent(chunk.content)
      }
    }
  } finally {
    reader.releaseLock()
  }
  return acc
}

export default {
  fetch: withApi<any>(async (request, context) => {
    const currentRequestId = extractRequestId(request)
    const userId = context.userClaims!.id

    if (request.method !== 'POST') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const parsed = chatRequestSchema.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) {
      return apiError('INVALID_REQUEST', '요청을 확인해 주세요.', 400, currentRequestId, {
        issues: parsed.error.issues,
      })
    }

    const service = serviceClient()

    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    const { count: recentCount, error: rateError } = await service
      .from('agent_chat_requests')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', hourAgo)
    if (rateError) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'agent_cloud_chat.rate_check',
          error: rateError,
        }),
      )
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
    if ((recentCount ?? 0) >= RATE_LIMIT_PER_HOUR) {
      return apiError(
        'RATE_LIMITED',
        '시간당 요청 한도를 넘었어요. 잠시 후 다시 시도해 주세요.',
        429,
        currentRequestId,
      )
    }

    const { data: keyRow, error: keyError } = await service
      .from('user_api_keys')
      .select('secret_id')
      .eq('user_id', userId)
      .eq('provider', OPENROUTER_PROVIDER)
      .maybeSingle()
    if (keyError) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'agent_cloud_chat.key',
          error: keyError,
        }),
      )
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
    if (!keyRow) {
      // RESOURCE_NOT_FOUND (the connection resource) rather than
      // INVALID_REQUEST -- the client's ScheduleAPIError.server already
      // parses the top-level `code`, so this needs to be a distinct,
      // existing ErrorCode it can match on rather than a nested detail.
      return apiError('RESOURCE_NOT_FOUND', 'OpenRouter 연결이 필요해요.', 404, currentRequestId)
    }
    const { data: apiKey, error: readError } = await service.rpc('vault_read_secret', {
      p_id: keyRow.secret_id,
    })
    if (readError || !apiKey) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'agent_cloud_chat.key_read',
          error: readError,
        }),
      )
      return apiError('INTERNAL_ERROR', 'API 키를 불러오지 못했습니다.', 500, currentRequestId)
    }

    // Logged now (not after) so a request that errors out or times out mid-
    // flight still counts against the window -- otherwise a slow/failing
    // loop would be invisible to the rate limit that exists to catch it.
    const logged = await service.from('agent_chat_requests').insert({ user_id: userId })
    if (logged.error) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'agent_cloud_chat.rate_log',
          error: logged.error,
        }),
      )
    }

    const today = new Date()
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(toISODate(today)) },
      ...parsed.data.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: parsed.data.message },
    ]
    const model = parsed.data.model || Deno.env.get('OPENROUTER_MODEL') || DEFAULT_OPENROUTER_MODEL

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))

        let proposedSchedule: (ProposedScheduleArgs & { note?: string }) | null = null
        let conflictTitle: string | null = null

        try {
          for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            const acc = await callOpenRouterStreamed(
              apiKey,
              model,
              messages,
              (delta) => send({ delta }),
            )
            const toolCalls = accumulatedToolCallsArray(acc)

            if (toolCalls.length === 0) {
              send({
                done: true,
                proposedSchedule: proposedSchedule ? { ...proposedSchedule, conflictTitle } : null,
              })
              controller.close()
              return
            }

            messages.push({
              role: 'assistant',
              content: acc.content || null,
              tool_calls: toolCalls,
            })

            for (const call of toolCalls) {
              const args = JSON.parse(call.function.arguments || '{}')
              let result: unknown
              switch (call.function.name) {
                case 'search_schedules':
                  result = await searchSchedules(context.supabase, args)
                  break
                case 'find_free_slots':
                  result = await findFreeSlots(context.supabase, args)
                  break
                case 'propose_schedule': {
                  proposedSchedule = args
                  // Reflection: guaranteed, not dependent on the model
                  // having called search_schedules first (the system
                  // prompt asks it to, but nothing enforces that).
                  const proposedDate = resolveDate(args.date ?? 'today', today)
                  const existing = await fetchSchedules(
                    context.supabase,
                    proposedDate,
                    proposedDate,
                  )
                    .catch(() => [] as ExistingScheduleRow[])
                  conflictTitle = findConflict(existing, args, today)
                  result = conflictTitle
                    ? { ok: true, warning: `Conflicts with existing '${conflictTitle}'` }
                    : { ok: true }
                  break
                }
                default:
                  result = { error: 'unknown tool' }
              }
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify(result),
              })
            }
          }
          // Ran out of iterations without a final text turn.
          send({
            done: true,
            proposedSchedule: proposedSchedule ? { ...proposedSchedule, conflictTitle } : null,
          })
          controller.close()
        } catch (error) {
          console.error(
            JSON.stringify({
              requestId: currentRequestId,
              operation: 'agent_cloud_chat',
              error: String(error),
            }),
          )
          send({ error: 'Agent 응답을 받지 못했습니다.' })
          controller.close()
        }
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'X-Request-ID': currentRequestId,
      },
    })
  }),
}
