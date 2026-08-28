// SSE stream parsing/accumulation for agent-cloud-chat's OpenRouter calls --
// pure (the actual fetch/reader loop lives in agent-cloud-chat/index.ts,
// this is just the part worth unit-testing in isolation). Split out of
// agent-cloud-contract.ts (second-pass D1-D4 review): this block has zero
// dependency on anything else in that file -- no DB access, no tool
// dispatch, no Memdo domain types -- it's entirely about parsing
// OpenRouter's own wire format, a genuinely separate responsibility from
// "what Memdo's tools do" that agent-cloud-contract.ts otherwise covers.
//
// OpenRouter proxies OpenAI's streaming format regardless of the underlying
// model: content and tool_calls never appear in the same turn, and
// tool_calls arrive as index-keyed deltas (id/name/arguments arrive
// separately and must be concatenated) rather than one complete object.

export type StreamToolCallDelta = {
  index: number
  id?: string
  name?: string
  argumentsChunk?: string
}

export type StreamChunk = {
  content?: string
  toolCalls?: StreamToolCallDelta[]
  finishReason?: string | null
  usage?: AgentUsage
  // OpenRouter's chatcmpl-... completion id, present on every chunk of one
  // completion (an id read from stream data, not an HTTP request-
  // correlation id).
  id?: string
  // The actual underlying model OpenRouter routed this completion to --
  // only meaningfully different from the requested model id for an
  // auto-router alias (e.g. openrouter/free, D3). Read for the founder
  // debug trace (D2); previously present on the wire and silently
  // discarded.
  model?: string
}

export type AgentUsage = {
  promptTokens: number
  completionTokens: number
  costUsd: number
}

/** Parses one raw SSE line ("data: {...}") into a normalized chunk. Returns
 * null for the "[DONE]" terminator, blank lines, or anything with no content,
 * tool call, finish reason, or final usage worth acting on. */
export function parseStreamLine(rawLine: string): StreamChunk | null {
  const trimmed = rawLine.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return null

  let parsed: any
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  const chunk: StreamChunk = {}
  const delta = parsed?.choices?.[0]?.delta
  if (typeof delta?.content === 'string' && delta.content.length > 0) {
    chunk.content = delta.content
  }
  if (Array.isArray(delta?.tool_calls)) {
    chunk.toolCalls = delta.tool_calls.map((tc: any) => ({
      index: tc.index ?? 0,
      id: tc.id,
      name: tc.function?.name,
      argumentsChunk: tc.function?.arguments,
    }))
  }
  const finishReason = parsed.choices?.[0]?.finish_reason
  if (finishReason) chunk.finishReason = finishReason
  const usage = parsed?.usage
  if (
    usage && Number.isFinite(usage.prompt_tokens) &&
    Number.isFinite(usage.completion_tokens) && Number.isFinite(usage.cost)
  ) {
    chunk.usage = {
      promptTokens: Math.max(0, usage.prompt_tokens),
      completionTokens: Math.max(0, usage.completion_tokens),
      costUsd: Math.max(0, usage.cost),
    }
  }
  if (typeof parsed.id === 'string' && parsed.id.length > 0) chunk.id = parsed.id
  if (typeof parsed.model === 'string' && parsed.model.length > 0) chunk.model = parsed.model
  return chunk.content || chunk.toolCalls || chunk.finishReason || chunk.usage || chunk.id ||
      chunk.model
    ? chunk
    : null
}

export type AccumulatedToolCall = { id: string; name: string; arguments: string }

export type StreamAccumulator = {
  content: string
  toolCalls: Map<number, AccumulatedToolCall>
  usage: AgentUsage
  // Last successfully observed OpenRouter completion id -- an id read from
  // stream data, not an HTTP request-correlation id (see
  // agent_audit_log.provider_completion_id's column comment).
  providerCompletionId: string | null
  // Last successfully observed resolved model id (StreamChunk.model's doc
  // comment) -- read for the founder debug trace (D2), not persisted
  // anywhere (agent_audit_log's `model` column is the *requested* model,
  // untouched by this).
  resolvedModel: string | null
}

export function newStreamAccumulator(): StreamAccumulator {
  return {
    content: '',
    toolCalls: new Map(),
    usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
    providerCompletionId: null,
    resolvedModel: null,
  }
}

export function applyStreamChunk(acc: StreamAccumulator, chunk: StreamChunk): void {
  if (chunk.content) acc.content += chunk.content
  for (const delta of chunk.toolCalls ?? []) {
    const existing = acc.toolCalls.get(delta.index) ?? { id: '', name: '', arguments: '' }
    if (delta.id) existing.id = delta.id
    if (delta.name) existing.name = delta.name
    if (delta.argumentsChunk) existing.arguments += delta.argumentsChunk
    acc.toolCalls.set(delta.index, existing)
  }
  if (chunk.usage) acc.usage = chunk.usage
  if (chunk.id) acc.providerCompletionId = chunk.id
  if (chunk.model) acc.resolvedModel = chunk.model
}

export function addAgentUsage(total: AgentUsage, usage: AgentUsage): void {
  total.promptTokens += usage.promptTokens
  total.completionTokens += usage.completionTokens
  total.costUsd += usage.costUsd
}

/** Reconstructs the tool_calls array shape the OpenAI/OpenRouter messages
 * format expects, so the accumulated turn can be pushed back into the
 * conversation the same way a non-streamed response's `choice` would be. */
export function accumulatedToolCallsArray(
  acc: StreamAccumulator,
): Array<{ id: string; function: { name: string; arguments: string } }> {
  return Array.from(acc.toolCalls.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({ id: tc.id, function: { name: tc.name, arguments: tc.arguments } }))
}
