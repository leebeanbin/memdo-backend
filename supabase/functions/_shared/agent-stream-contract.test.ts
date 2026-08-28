import {
  accumulatedToolCallsArray,
  addAgentUsage,
  applyStreamChunk,
  newStreamAccumulator,
  parseStreamLine,
} from './agent-stream-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

Deno.test('parseStreamLine ignores [DONE] and non-data lines', () => {
  assert(parseStreamLine('data: [DONE]') === null)
  assert(parseStreamLine('') === null)
  assert(parseStreamLine(': keep-alive') === null)
})

Deno.test('parseStreamLine extracts a content delta', () => {
  const chunk = parseStreamLine(
    'data: {"choices":[{"delta":{"content":"안녕"},"finish_reason":null}]}',
  )
  assert(chunk?.content === '안녕')
  assert(chunk?.toolCalls === undefined)
})

Deno.test('parseStreamLine extracts a tool_call delta', () => {
  const chunk = parseStreamLine(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"propose_schedule","arguments":"{\\"tit"}}]},"finish_reason":null}]}',
  )
  assert(chunk?.toolCalls?.length === 1)
  assert(chunk?.toolCalls?.[0].id === 'call_1')
  assert(chunk?.toolCalls?.[0].name === 'propose_schedule')
  assert(chunk?.toolCalls?.[0].argumentsChunk === '{"tit')
})

Deno.test('parseStreamLine extracts usage from the final chunk without a delta', () => {
  const chunk = parseStreamLine(
    'data: {"choices":[],"usage":{"prompt_tokens":194,"completion_tokens":2,"total_tokens":196,"cost":0.00095}}',
  )
  assert(chunk?.usage?.promptTokens === 194)
  assert(chunk?.usage?.completionTokens === 2)
  assert(chunk?.usage?.costUsd === 0.00095)
})

Deno.test('parseStreamLine extracts id alongside a content delta', () => {
  const chunk = parseStreamLine(
    'data: {"id":"chatcmpl-abc123","choices":[{"delta":{"content":"안녕"},"finish_reason":null}]}',
  )
  assert(chunk?.content === '안녕')
  assert(chunk?.id === 'chatcmpl-abc123')
})

Deno.test('parseStreamLine extracts the resolved model (D2 founder trace)', () => {
  const chunk = parseStreamLine(
    'data: {"model":"nvidia/nemotron-3-super-120b-a12b:free","choices":[{"delta":{"content":"안녕"},"finish_reason":null}]}',
  )
  assert(chunk?.model === 'nvidia/nemotron-3-super-120b-a12b:free')
})

Deno.test('parseStreamLine returns a chunk for model alone, even with no content/tool_calls', () => {
  const chunk = parseStreamLine('data: {"model":"openai/gpt-5.4-mini","choices":[]}')
  assert(chunk?.model === 'openai/gpt-5.4-mini')
})

Deno.test('applyStreamChunk concatenates content across chunks', () => {
  const acc = newStreamAccumulator()
  applyStreamChunk(acc, { content: '안' })
  applyStreamChunk(acc, { content: '녕' })
  assert(acc.content === '안녕')
})

Deno.test('applyStreamChunk sets providerCompletionId and a later chunk without id does not clear it', () => {
  const acc = newStreamAccumulator()
  assert(acc.providerCompletionId === null)
  applyStreamChunk(acc, { id: 'chatcmpl-abc123', content: '안' })
  assert(acc.providerCompletionId === 'chatcmpl-abc123')
  applyStreamChunk(acc, { content: '녕' })
  assert(acc.providerCompletionId === 'chatcmpl-abc123')
})

Deno.test('applyStreamChunk sets resolvedModel and a later chunk without model does not clear it (D2)', () => {
  const acc = newStreamAccumulator()
  assert(acc.resolvedModel === null)
  applyStreamChunk(acc, { model: 'nvidia/nemotron-3-super-120b-a12b:free', content: '안' })
  assert(acc.resolvedModel === 'nvidia/nemotron-3-super-120b-a12b:free')
  applyStreamChunk(acc, { content: '녕' })
  assert(acc.resolvedModel === 'nvidia/nemotron-3-super-120b-a12b:free')
})

Deno.test('addAgentUsage totals every tool-loop request', () => {
  const total = newStreamAccumulator().usage
  addAgentUsage(total, { promptTokens: 10, completionTokens: 2, costUsd: 0.001 })
  addAgentUsage(total, { promptTokens: 20, completionTokens: 3, costUsd: 0.002 })
  assert(total.promptTokens === 30)
  assert(total.completionTokens === 5)
  assert(total.costUsd === 0.003)
})

Deno.test('applyStreamChunk accumulates a tool call split across many deltas', () => {
  const acc = newStreamAccumulator()
  applyStreamChunk(acc, { toolCalls: [{ index: 0, id: 'call_1', name: 'propose_schedule' }] })
  applyStreamChunk(acc, { toolCalls: [{ index: 0, argumentsChunk: '{"title":' }] })
  applyStreamChunk(acc, { toolCalls: [{ index: 0, argumentsChunk: '"점심"}' }] })

  const calls = accumulatedToolCallsArray(acc)
  assert(calls.length === 1)
  assert(calls[0].id === 'call_1')
  assert(calls[0].function.name === 'propose_schedule')
  assert(calls[0].function.arguments === '{"title":"점심"}')
  assert(JSON.parse(calls[0].function.arguments).title === '점심')
})

Deno.test('applyStreamChunk keeps multiple concurrent tool calls separate by index', () => {
  const acc = newStreamAccumulator()
  applyStreamChunk(acc, {
    toolCalls: [
      { index: 0, id: 'call_1', name: 'search_schedules' },
      { index: 1, id: 'call_2', name: 'find_free_slots' },
    ],
  })
  const calls = accumulatedToolCallsArray(acc)
  assert(calls.length === 2)
  assert(calls[0].function.name === 'search_schedules')
  assert(calls[1].function.name === 'find_free_slots')
})
