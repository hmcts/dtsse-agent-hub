import type { VirtualAgentDesired, VirtualAgentStatus } from "../virtual-agents/lifecycle.ts";
import type { PluginOption } from "../virtual-agents/plugins.ts";

/**
 * What the Assistant's settings need that is not a sign-in or an appearance. Pure, so the page can build it and the
 * dialog, which is a client component, only renders it.
 */

export interface AssistantPluginsData {
  /** The virtual agent the Assistant runs on: plugins belong to it, not to one conversation. */
  assistantId: string;
  available: PluginOption[];
  checked: string[];
  /** Its pod is up, so saving replaces it rather than being picked up at its next start. */
  podRunning: boolean;
}

/**
 * The plugins half of settings, or `undefined` when there is none to show. `podRunning` is the rule the hub's own
 * plugins panel uses: a pod exists from the moment the orchestrator has acted on a `running` agent, which is every
 * status but `requested`.
 *
 * A `null` configuration hides the section rather than showing an empty one, because the hub cannot then tell which
 * of the person's own plugins it still offers, and would both mislabel every one of them and refuse every save.
 */
export function assistantPluginsData(
  assistant: { id: string; desired: VirtualAgentDesired; status: VirtualAgentStatus },
  plugins: { available: PluginOption[]; checked: string[] } | null
): AssistantPluginsData | undefined {
  if (plugins === null) {
    return undefined;
  }
  return {
    assistantId: assistant.id,
    available: plugins.available,
    checked: plugins.checked,
    podRunning: assistant.desired === "running" && assistant.status !== "requested"
  };
}
