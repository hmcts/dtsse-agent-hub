import type { Api, RequestOptions } from "./api.ts";

/** The ids of the caller's own agents, or null when the hub cannot say: a caller then claims nothing about whose an agent is. */
export async function ownAgentIdSet(api: Pick<Api, "agents">, opts?: RequestOptions): Promise<Set<string> | null> {
  try {
    return new Set((await api.agents(opts)).agents.map((a) => a.id));
  } catch {
    return null;
  }
}
