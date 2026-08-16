import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  chatRequestSchema,
  cloudAgentTools,
  DEFAULT_OPENROUTER_MODEL,
  MAX_TOOL_ITERATIONS,
  OPENROUTER_CHAT_URL,
  systemPrompt,
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

function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

async function searchSchedules(
  supabase: { from: (table: string) => any },
  args: { from?: string; to?: string },
): Promise<unknown> {
  if (!args.from || !args.to) return { error: 'from and to are required' }
  const { data, error } = await supabase
    .from('todos')
    .select('title,entry_kind,scheduled_date,start_at,end_at,status')
    .is('deleted_at', null)
    .gte('scheduled_date', args.from)
    .lte('scheduled_date', args.to)
    .order('scheduled_date')
    .limit(100)
  if (error) return { error: error.message }
  return { items: data }
}

async function findFreeSlots(
  supabase: { from: (table: string) => any },
  args: { scope?: string; durationMinutes?: number; windowStart?: string; windowEnd?: string },
): Promise<unknown> {
  const dates = expandScope(args.scope ?? 'today')
  const duration = Math.max(15, args.durationMinutes ?? 30) * 60_000
  const from = dates[0]
  const to = dates.at(-1) ?? dates[0]

  const { data, error } = await supabase
    .from('todos')
    .select('scheduled_date,start_at,end_at')
    .is('deleted_at', null)
    .eq('entry_kind', 'event')
    .gte('scheduled_date', from)
    .lte('scheduled_date', to)
  if (error) return { error: error.message }

  const busy =
    (data as { scheduled_date: string; start_at: string | null; end_at: string | null }[])
      .filter((row) => row.start_at && row.end_at)

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

function expandScope(scope: string): string[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const toISODate = (d: Date) => d.toISOString().slice(0, 10)
  if (scope === 'today') return [toISODate(today)]
  if (scope === 'tomorrow') {
    const d = new Date(today)
    d.setDate(d.getDate() + 1)
    return [toISODate(d)]
  }
  if (scope === 'this_week') {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today)
      d.setDate(d.getDate() + i)
      return toISODate(d)
    })
  }
  return [scope]
}

function timeOn(dateStr: string, hhmm: string | undefined): Date | null {
  if (!hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  const date = new Date(`${dateStr}T00:00:00`)
  date.setHours(h, m, 0, 0)
  return date
}

function formatSlot(start: Date, end: Date): string {
  const fmt = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${fmt(start)}-${fmt(end)}`
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()
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
      return apiError('INVALID_REQUEST', 'OpenRouter 연결이 필요해요.', 400, currentRequestId, {
        code: 'NOT_CONNECTED',
      })
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

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(todayString()) },
      ...parsed.data.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: parsed.data.message },
    ]

    let proposedSchedule: Record<string, unknown> | null = null
    let finalText: string | null = null

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const response = await fetch(OPENROUTER_CHAT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: Deno.env.get('OPENROUTER_MODEL') || DEFAULT_OPENROUTER_MODEL,
            messages,
            tools: cloudAgentTools,
          }),
        })
        if (!response.ok) {
          throw new Error(`openrouter ${response.status}: ${await response.text()}`)
        }
        const body = await response.json()
        const choice = body.choices?.[0]?.message
        if (!choice) throw new Error('openrouter returned no message')
        messages.push(choice)

        const toolCalls = choice.tool_calls ?? []
        if (toolCalls.length === 0) {
          finalText = choice.content ?? ''
          break
        }

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
            case 'propose_schedule':
              proposedSchedule = args
              result = { ok: true }
              break
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
    } catch (error) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'agent_cloud_chat',
          error: String(error),
        }),
      )
      return apiError('INTERNAL_ERROR', 'Agent 응답을 받지 못했습니다.', 502, currentRequestId)
    }

    const body = {
      message: finalText ?? '요청을 처리하지 못했어요. 다시 시도해 주세요.',
      proposedSchedule,
    }
    logRequest({
      eventName: 'agent_cloud_chat.reply',
      requestId: currentRequestId,
      routeTemplate: '/agent-cloud-chat',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: 0,
    })
    return json(body, 200, currentRequestId)
  }),
}
