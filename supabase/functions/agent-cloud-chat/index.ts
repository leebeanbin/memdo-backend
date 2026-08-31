import { AGENT_WORKFLOW_NAME, type AgentAuditResultKind } from '../_shared/agent-audit-contract.ts'
import {
  buildDonePayload,
  chatRequestSchema,
  cloudAgentTools,
  dispatchToolCall,
  MAX_TOOL_ITERATIONS,
  newToolDispatchState,
  OPENROUTER_CHAT_URL,
  resolveDate,
  resolveOpenRouterModel,
  resolveRateLimitPerHour,
  systemPrompt,
} from '../_shared/agent-cloud-contract.ts'
import { OPENROUTER_PROVIDER } from '../_shared/agent-key-contract.ts'
import {
  accumulatedToolCallsArray,
  addAgentUsage,
  type AgentUsage,
  applyStreamChunk,
  newStreamAccumulator,
  parseStreamLine,
  type StreamAccumulator,
} from '../_shared/agent-stream-contract.ts'
import { serviceClient } from '../_shared/google-calendar-contract.ts'
import { apiError, errorEnvelope, normalizeZodIssues, withApi } from '../_shared/http.ts'
import { isExperimentalModelSelectable } from '../_shared/model-registry-contract.ts'

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
        issues: normalizeZodIssues(parsed.error.issues),
      })
    }

    const service = serviceClient()

    // Atomic count+insert via RPC (20260830033440_agent_rate_limit_atomic.sql)
    // -- the old check-then-insert (separate SELECT count, then a later
    // INSERT after the Vault read) let concurrent requests all read the same
    // count and all pass, and fail-open on insert error meant the limit
    // could silently stop counting entirely. This call fails *closed*: an
    // RPC error rejects the request rather than letting it through
    // unmetered. Found via founder-dogfooding code review (be4).
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    const effectiveLimit = resolveRateLimitPerHour(userId, {
      evalAccountUserId: Deno.env.get('MEMDO_EVAL_ACCOUNT_USER_ID'),
      evalRateLimitEnabled: Deno.env.get('MEMDO_EVAL_RATE_LIMIT_ENABLED'),
      evalRateLimitPerHour: Deno.env.get('MEMDO_EVAL_RATE_LIMIT_PER_HOUR'),
    })
    const { data: rateData, error: rateError } = await service
      .rpc('agent_rate_limit_check_and_log', {
        p_user_id: userId,
        p_window_start: hourAgo,
        p_limit: effectiveLimit,
      })
      .single()
    const rateResult = rateData as { allowed: boolean; current_count: number } | null
    if (rateError || !rateResult) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'agent_cloud_chat.rate_check',
          error: rateError,
        }),
      )
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
    if (!rateResult.allowed) {
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

    // Request already logged against the rate-limit window by
    // agent_rate_limit_check_and_log above (atomic with the check itself) --
    // no separate insert needed here anymore.

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
    const model = resolveOpenRouterModel(parsed.data.model)

    // D3 second-pass review: tier 'experimental' models were UI-hidden but
    // still backend-selectable (chatRequestSchema only gates on enabled/
    // supportsTools). Every non-experimental model passes this unchanged.
    if (
      !isExperimentalModelSelectable(userId, model, undefined, {
        experimentalModelsUserId: Deno.env.get('MEMDO_EXPERIMENTAL_MODELS_USER_ID'),
      })
    ) {
      return apiError('INVALID_REQUEST', '아직 사용할 수 없는 모델이에요.', 400, currentRequestId)
    }

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
        const send = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
          } catch {
            // be11: the client disconnected mid-stream -- enqueueing on a
            // closed/errored controller throws. Previously this propagated
            // out of send(): the main try block's catch (below) called
            // send() again to report the error, which threw the exact same
            // way, becoming an unhandled rejection that skipped close()
            // entirely -- so a disconnected client's turn never got its
            // agent_audit_log row. Swallowed here instead; there's no
            // client left to deliver this chunk to either way.
          }
        }

        const dispatchState = newToolDispatchState()
        const totalUsage: AgentUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 }
        let completedCalls = 0
        let lastProviderCompletionId: string | null = null
        let lastResolvedModel: string | null = null

        // Built fresh from dispatchState at both send sites below
        // (no-tool-calls exit and ran-out-of-iterations exit) via the same
        // buildDonePayload() so they can't drift apart. latencyMs is
        // computed here (not inside close(), which runs after and serves
        // agent_audit_log instead) so the founder trace (D2, AgentTurnTrace)
        // reflects this turn's own duration, not observability overhead.
        const donePayload = () =>
          buildDonePayload(
            dispatchState,
            {
              requestedModel: model,
              resolvedModel: lastResolvedModel,
              latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
            },
            parsed.data.debug === true,
          )

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

          try {
            controller.close()
          } catch {
            // be11: already closed -- e.g. the platform closed it after a
            // client disconnect. Nothing left to do.
          }
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
            lastResolvedModel = acc.resolvedModel ?? lastResolvedModel
            // A call with no id/name (streamed deltas that never carried
            // them) can't be pushed into the assistant message below --
            // OpenRouter 400s the *next* request over a malformed
            // tool_calls entry, which would kill the turn just as hard as
            // the JSON.parse failure this same fix targets. Drop them here,
            // before they ever become part of the conversation, rather than
            // trying to respond to something the model never coherently
            // asked for.
            const toolCalls = accumulatedToolCallsArray(acc).filter((call) =>
              call.id && call.function.name
            )

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
              // Sent BEFORE the (possibly slow) handler runs -- the one real
              // signal a client can use for a truthful, live "tool is
              // executing" hint (D4), as opposed to inferring it from the
              // terminal done payload's toolNames after everything already
              // happened. Carries only the tool name, no args/results --
              // those stay in the founder debug trace (D2), not this
              // user-facing surface.
              send({ toolCallStarted: call.function.name })
              // Streamed argument deltas can arrive truncated or slightly
              // malformed (routine with the `:free` experimental models) --
              // JSON.parse throwing here used to escape the whole turn, even
              // though parseAgentToolCall/dispatchToolCall already have a
              // graceful, model-recoverable INVALID_AGENT_ARGUMENT path for
              // "valid JSON, wrong shape." Give a bad-JSON call that exact
              // same shape instead of a hard failure.
              let result: unknown
              try {
                const args = JSON.parse(call.function.arguments || '{}')
                result = await dispatchToolCall(
                  context.supabase,
                  call.function.name,
                  args,
                  dispatchState,
                  today,
                )
              } catch (parseError) {
                if (!(parseError instanceof SyntaxError)) throw parseError
                console.error(
                  JSON.stringify({
                    requestId: currentRequestId,
                    operation: 'agent_cloud_chat.malformed_tool_arguments',
                    toolName: call.function.name,
                  }),
                )
                result = {
                  error: 'INVALID_AGENT_ARGUMENT',
                  issues: [{ field: '(root)', reason: 'arguments were not valid JSON' }],
                }
              }
              // Sent immediately after the handler resolves -- second-pass
              // review finding: toolCallStarted alone left the client's
              // hint showing "tool is executing" for the whole gap between
              // the handler actually finishing and the model's next visible
              // token, which is a fake progress state, not a truthful one.
              // Client clears its hint on this event; a following
              // toolCallStarted (another call in the same turn) replaces it
              // again, same as before.
              send({ toolCallFinished: call.function.name })
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
          // bd24: same envelope every other error response in this API
          // uses, instead of a bare {error: string} unique to this one
          // mid-stream path.
          send(errorEnvelope('INTERNAL_ERROR', 'Agent 응답을 받지 못했습니다.', currentRequestId))
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
