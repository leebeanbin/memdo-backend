// Exactly the 3 exit paths in agent-cloud-chat/index.ts's stream handler --
// the tool loop ended with a final text turn ('answered'), ran out of
// MAX_TOOL_ITERATIONS without one ('exhausted_iterations'), or the handler
// threw ('error'). Derived directly from control flow, not a separate
// semantic classification layered on top.
export type AgentAuditResultKind = 'answered' | 'exhausted_iterations' | 'error'

// Single agent workflow today (agent-cloud-chat's tool loop) -- kept as a
// real value, not inlined, so a future distinct workflow (e.g. a
// routine/review agent path) doesn't need a migration to become
// distinguishable. Same reasoning as ModelProfile.supportsTools in Epic G.
export const AGENT_WORKFLOW_NAME = 'agent_cloud_chat'
