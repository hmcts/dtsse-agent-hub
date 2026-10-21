import { type Environment, virtualAgentsEnabled } from "../virtual-agents/settings.ts";

/**
 * The HMCTS Assistant's feature flag, read per call like the virtual agents' own. An assistant is a virtual agent, so
 * it is off whenever they are, whatever `ASSISTANT_ENABLED` says.
 */
export function assistantEnabled(env: Environment = process.env): boolean {
  return virtualAgentsEnabled(env) && env.ASSISTANT_ENABLED === "true";
}
