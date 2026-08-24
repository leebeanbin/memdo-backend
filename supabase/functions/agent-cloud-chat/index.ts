import { AGENT_WORKFLOW_NAME, type AgentAuditResultKind } from '../_shared/agent-audit-contract.ts'
import {
  accumulatedToolCallsArray,
  addAgentUsage,
  type AgentUsage,
  applyStreamChunk,
  buildDonePayload,
  chatRequestSchema,
  cloudAgentTools,
  DEFAULT_OPENROUTER_MODEL,
  dispatchToolCall,
  MAX_TOOL_ITERATIONS,
  newStreamAccumulator,
  newToolDispatchState,
  OPENROUTER_CHAT_URL,
  parseStreamLine,
  resolveDate,
  resolveRateLimitPerHour,
  type StreamAccumulator,
  systemPrompt,
} from '../_shared/agent-cloud-contract.ts'
import { OPENROUTER_PROVIDER } from '../_shared/agent-key-contract.ts'
import { serviceClient } from '../_shared/google-calendar-contract.ts'
import { apiError, withApi } from '../_shared/http.ts'

type ChatMessage = {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
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
    buffer += decoder.decode()
    const finalChunk = parseStreamLine(buffer)
    if (finalChunk) {
      applyStreamChunk(acc, finalChunk)
      if (finalChunk.content && onContent) onContent(finalChunk.content)
    }
  } finally {
    reader.releaseLock()
  }
  return acc
}

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
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
    const effectiveLimit = resolveRateLimitPerHour(userId, {
      evalAccountUserId: Deno.env.get('MEMDO_EVAL_ACCOUNT_USER_ID'),
      evalRateLimitEnabled: Deno.env.get('MEMDO_EVAL_RATE_LIMIT_ENABLED'),
      evalRateLimitPerHour: Deno.env.get('MEMDO_EVAL_RATE_LIMIT_PER_HOUR'),
    })
    if ((recentCount ?? 0) >= effectiveLimit) {
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
    // resolveDate('today', ...) applies DEFAULT_TIMEZONE_OFFSET_MINUTES the
    // same way every tool-argument date resolution below does -- a bare
    // toISODate(today) here would tell the model UTC's date, which
    // disagrees with what resolveDate('today', ...) computes for the model's
    // own tool calls during the ~9h/day window where UTC and KST fall on
    // different calendar days.
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(resolveDate('today', today)) },
      ...parsed.data.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: parsed.data.message },
    ]
    const model = parsed.data.model || Deno.env.get('OPENROUTER_MODEL') || DEFAULT_OPENROUTER_MODEL

    // Generated only after every preflight check above has passed --
    // everything before this point (method/body validation, rate limit,
    // key lookup, vault read) exits before reaching here and is
    // deliberately not an audited agent execution. startedAt therefore
    // measures the accepted execution's own duration, not preflight/auth
    // overhead; agentRunId is independent of currentRequestId (client-
    // controllable via the X-Request-ID header) since it's the audit
    // table's DB-enforced uniqueness key.
    const startedAt = performance.now()
    const agentRunId = crypto.randomUUID()

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))

        const dispatchState = newToolDispatchState()
        const totalUsage: AgentUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 }
        let completedCalls = 0
        let lastProviderCompletionId: string | null = null

        // Built fresh from dispatchState at both send sites below
        // (no-tool-calls exit and ran-out-of-iterations exit) via the same
        // buildDonePayload() so they can't drift apart.
        const donePayload = () => buildDonePayload(dispatchState)

        const close = async (resultKind: AgentAuditResultKind) => {
          // Snapshotted before either DB write below runs, so it measures
          // the accepted execution's duration only -- not observability
          // overhead from persisting the result.
          const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))

          if (completedCalls > 0) {
            try {
              const logged = await service.from('agent_usage_log').insert({
                user_id: userId,
                model,
                prompt_tokens: totalUsage.promptTokens,
                completion_tokens: totalUsage.completionTokens,
                cost_usd: totalUsage.costUsd,
              })
              if (logged.error) throw logged.error
            } catch (error) {
              console.error(
                JSON.stringify({
                  requestId: currentRequestId,
                  operation: 'agent_cloud_chat.usage_log',
                  error: String(error),
                }),
              )
            }
          }

          // Unconditional (unlike agent_usage_log above) -- this is exactly
          // what covers a first-iteration OpenRouter failure with
          // completedCalls === 0, since that failure is caught by the
          // try/catch below and still reaches this close() call.
          // Failure-isolated, not "non-blocking": a failure here is caught
          // and logged, never changing the user-facing agent result, but
          // it's awaited before controller.close(), so it can delay when
          // the stream actually closes.
          try {
            const logged = await service.from('agent_audit_log').insert({
              agent_run_id: agentRunId,
              user_id: userId,
              workflow_name: AGENT_WORKFLOW_NAME,
              model,
              tool_names: dispatchState.dispatchedTools.map((t) => t.name),
              tool_call_count: dispatchState.dispatchedTools.length,
              latency_ms: latencyMs,
              result_kind: resultKind,
              provider_completion_id: lastProviderCompletionId,
            })
            if (logged.error) throw logged.error
          } catch (error) {
            console.error(
              JSON.stringify({
                requestId: currentRequestId,
                operation: 'agent_cloud_chat.audit_log',
                error: String(error),
              }),
            )
          }

          controller.close()
        }

        try {
          for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            const acc = await callOpenRouterStreamed(
              apiKey,
              model,
              messages,
              (delta) => send({ delta }),
            )
            addAgentUsage(totalUsage, acc.usage)
            completedCalls++
            lastProviderCompletionId = acc.providerCompletionId ?? lastProviderCompletionId
            const toolCalls = accumulatedToolCallsArray(acc)

            if (toolCalls.length === 0) {
              send(donePayload())
              await close('answered')
              return
            }

            messages.push({
              role: 'assistant',
              content: acc.content || null,
              tool_calls: toolCalls,
            })

            for (const call of toolCalls) {
              const args = JSON.parse(call.function.arguments || '{}')
              const result = await dispatchToolCall(
                context.supabase,
                call.function.name,
                args,
                dispatchState,
                today,
              )
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify(result),
              })
            }
          }
          // Ran out of iterations without a final text turn.
          send(donePayload())
          await close('exhausted_iterations')
        } catch (error) {
          console.error(
            JSON.stringify({
              requestId: currentRequestId,
              operation: 'agent_cloud_chat',
              error: String(error),
            }),
          )
          send({ error: 'Agent 응답을 받지 못했습니다.' })
          await close('error')
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
