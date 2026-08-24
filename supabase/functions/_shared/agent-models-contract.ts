import {
  type CostClass,
  type LatencyClass,
  MODEL_REGISTRY,
  type ModelProfile,
  selectableModelIds,
} from './model-registry-contract.ts'

export const OPENROUTER_MODELS_URL =
  'https://openrouter.ai/api/v1/models?input_modalities=text&output_modalities=text&supported_parameters=tools&sort=pricing-low-to-high'

export type AgentModel = {
  id: string
  name: string
  promptPricePerM: number
  completionPricePerM: number
  contextLength: number
  latencyClass: LatencyClass | null
  costClass: CostClass | null
  evalScore: number | null
}

// registry defaults to MODEL_REGISTRY so production call sites are
// unchanged (`agentModelsFromOpenRouter(payload)`); the parameter exists so
// tests can inject a synthetic ModelProfile[] to exercise registry states
// today's real MODEL_REGISTRY can't produce (e.g. every real entry has
// supportsTools: true right now, so testing the supportsTools=false path
// needs a fake entry, not the production constant).
export function agentModelsFromOpenRouter(
  payload: unknown,
  registry: ModelProfile[] = MODEL_REGISTRY,
): AgentModel[] {
  const rows = (payload as { data?: unknown[] })?.data
  if (!Array.isArray(rows)) return []

  // Registry-side eligibility ("do we allow this model at all?") --
  // independent of the live OpenRouter validation below ("is it actually
  // usable right now?"). Both gates must pass for a model to appear in the
  // returned catalog.
  const selectableIds = new Set(selectableModelIds(registry))
  const profiles = new Map(registry.filter((m) => selectableIds.has(m.id)).map((m) => [m.id, m]))

  return rows.flatMap((raw) => {
    const row = raw as Record<string, any>
    const prompt = Number(row.pricing?.prompt)
    const completion = Number(row.pricing?.completion)
    const input = row.architecture?.input_modalities
    const output = row.architecture?.output_modalities
    const profile = typeof row.id === 'string' ? profiles.get(row.id) : undefined
    if (
      typeof row.id !== 'string' || !profile ||
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
      latencyClass: profile.latencyClass,
      costClass: profile.costClass,
      evalScore: profile.evalScore,
    }]
  }).sort((a, b) => a.promptPricePerM - b.promptPricePerM)
}
