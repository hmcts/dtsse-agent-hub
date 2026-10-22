// Whether this process is a virtual agent's pod, and which agent it is. This is the single predicate: the pod's
// id and its launch token are minted together by the orchestrator, so one without the other is not a pod.
//
// `bin/agent-hub` carries a bash copy of the same test, because bash cannot call this. `src/bin.test.ts` drives
// both over one environment matrix and asserts they agree.
import type { Env } from "./env.ts";

export type VirtualAgent = {
  id: string;
  launchToken: string;
};

export const MISSING_VIRTUAL_AGENT_ID = "AGENT_HUB_VIRTUAL_AGENT_ID is not set; this only runs in a virtual agent pod";
export const MISSING_LAUNCH_TOKEN = "AGENT_HUB_LAUNCH_TOKEN is not set";

export function virtualAgent(env: Env = process.env): VirtualAgent | null {
  const id = env.AGENT_HUB_VIRTUAL_AGENT_ID;
  const launchToken = env.AGENT_HUB_LAUNCH_TOKEN;
  if (!id || !launchToken) {
    return null;
  }
  return { id, launchToken };
}

// For a caller that has to tell a person why their command will not run — the `virtual` subcommands, which are
// only ever invoked inside a pod.
export function requireVirtualAgent(env: Env = process.env): VirtualAgent {
  const agent = virtualAgent(env);
  if (!agent) {
    throw new Error(env.AGENT_HUB_VIRTUAL_AGENT_ID ? MISSING_LAUNCH_TOKEN : MISSING_VIRTUAL_AGENT_ID);
  }
  return agent;
}
