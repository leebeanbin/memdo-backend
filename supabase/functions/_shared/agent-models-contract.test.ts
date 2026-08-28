import { agentModelsFromOpenRouter } from './agent-models-contract.ts'
import type { ModelProfile } from './model-registry-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

function profile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'test/model',
    supportsTools: true,
    tier: 'recommended',
    latencyClass: null,
    costClass: null,
    evalScore: null,
    enabled: true,
    ...overrides,
  }
}

Deno.test('agentModelsFromOpenRouter filters unsupported models and converts per-token prices', () => {
  const models = agentModelsFromOpenRouter({
    data: [
      {
        id: 'openai/gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        pricing: { prompt: '0.000002', completion: '0.000006' },
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'openai/gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        pricing: { prompt: '0.00000025', completion: '0.000002' },
        context_length: 128_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'not-allowed/model',
        name: 'Not allowed',
        pricing: { prompt: '0', completion: '0' },
        context_length: 1_000_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
    ],
  })

  assert(models.length === 2)
  assert(models[0].id === 'openai/gpt-5.4-mini')
  assert(models[0].promptPricePerM === 0.25)
  assert(models[0].completionPricePerM === 2)
  assert(models[1].promptPricePerM === 2)
  // No registry entry has been promoted with eval:compare data yet -- these
  // stay null rather than some fabricated default.
  assert(models[0].latencyClass === null)
  assert(models[0].costClass === null)
  assert(models[0].evalScore === null)
  assert(models[0].tier === 'recommended')
})

Deno.test('agentModelsFromOpenRouter carries the free-auto tier through and never fabricates an evalScore for it', () => {
  const registry: ModelProfile[] = [
    profile({ id: 'openrouter/free', tier: 'free-auto' }),
  ]
  const models = agentModelsFromOpenRouter({
    data: [
      {
        id: 'openrouter/free',
        name: 'Free Models Router',
        pricing: { prompt: '0', completion: '0' },
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
    ],
  }, registry)

  assert(models.length === 1)
  assert(models[0].tier === 'free-auto')
  assert(models[0].promptPricePerM === 0)
  assert(models[0].evalScore === null)
})

Deno.test('agentModelsFromOpenRouter merges promoted registry fields onto the live catalog row', () => {
  const registry: ModelProfile[] = [
    profile({ id: 'test/model', latencyClass: 'fast', costClass: 'low', evalScore: 0.92 }),
  ]
  const models = agentModelsFromOpenRouter({
    data: [
      {
        id: 'test/model',
        name: 'Test Model',
        pricing: { prompt: '0.000001', completion: '0.000002' },
        context_length: 100_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
    ],
  }, registry)

  assert(models.length === 1)
  assert(models[0].latencyClass === 'fast')
  assert(models[0].costClass === 'low')
  assert(models[0].evalScore === 0.92)
})

Deno.test('agentModelsFromOpenRouter: registry-side supportsTools=false excludes a model even when OpenRouter reports tools support', () => {
  // enabled=true, supportsTools=false is not constructible against the real
  // MODEL_REGISTRY (every real entry today has supportsTools=true) -- this
  // is exactly why agentModelsFromOpenRouter takes an injectable registry.
  const registry: ModelProfile[] = [
    profile({ id: 'test/model', enabled: true, supportsTools: false }),
  ]
  const models = agentModelsFromOpenRouter({
    data: [
      {
        id: 'test/model',
        name: 'Test Model',
        pricing: { prompt: '0.000001', completion: '0.000002' },
        context_length: 100_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        // The live side alone would allow it -- registry-side eligibility
        // must still exclude it independently.
        supported_parameters: ['tools'],
      },
    ],
  }, registry)

  assert(models.length === 0)
})
