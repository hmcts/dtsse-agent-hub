/**
 * Where the UI shows an agent. A virtual agent's session is shown on its virtual agent's page, so every session one
 * virtual agent has registered opens the current one.
 */
export function agentPath(agent: { id: string; virtualAgentId: string | null }): string {
  return `/agents/${agent.virtualAgentId ?? agent.id}`;
}
