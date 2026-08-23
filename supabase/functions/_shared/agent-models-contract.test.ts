import { agentModelsFromOpenRouter } from './agent-models-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
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
})
