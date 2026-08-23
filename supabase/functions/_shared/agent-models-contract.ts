import { ALLOWED_OPENROUTER_MODELS } from './agent-cloud-contract.ts'

export const OPENROUTER_MODELS_URL =
  'https://openrouter.ai/api/v1/models?input_modalities=text&output_modalities=text&supported_parameters=tools&sort=pricing-low-to-high'

export type AgentModel = {
  id: string
  name: string
  promptPricePerM: number
  completionPricePerM: number
  contextLength: number
}

const allowedModels = new Set<string>(ALLOWED_OPENROUTER_MODELS)

export function agentModelsFromOpenRouter(payload: unknown): AgentModel[] {
  const rows = (payload as { data?: unknown[] })?.data
  if (!Array.isArray(rows)) return []

  return rows.flatMap((raw) => {
    const row = raw as Record<string, any>
    const prompt = Number(row.pricing?.prompt)
    const completion = Number(row.pricing?.completion)
    const input = row.architecture?.input_modalities
    const output = row.architecture?.output_modalities
    if (
      typeof row.id !== 'string' || !allowedModels.has(row.id) ||
      typeof row.name !== 'string' ||
      !Array.isArray(input) || !input.includes('text') ||
      !Array.isArray(output) || !output.includes('text') ||
      !Array.isArray(row.supported_parameters) || !row.supported_parameters.includes('tools') ||
      !Number.isFinite(prompt) || prompt < 0 ||
      !Number.isFinite(completion) || completion < 0 ||
      !Number.isFinite(row.context_length)
    ) return []

    return [{
      id: row.id,
      name: row.name,
      promptPricePerM: prompt * 1_000_000,
      completionPricePerM: completion * 1_000_000,
      contextLength: row.context_length,
    }]
  }).sort((a, b) => a.promptPricePerM - b.promptPricePerM)
}
