import type { VirtualAgentDesired, VirtualAgentStatus } from "./lifecycle.ts";

/**
 * How much CPU and memory a virtual agent's pod gets. The orchestrator turns a size into the container's resources;
 * the page describes each size from the same table.
 */

export const VIRTUAL_AGENT_SIZES = ["small", "medium", "large"] as const;

export type VirtualAgentSize = (typeof VIRTUAL_AGENT_SIZES)[number];

export const DEFAULT_SIZE: VirtualAgentSize = "small";

export interface SizeResources {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
}

export const SIZE_RESOURCES: Readonly<Record<VirtualAgentSize, SizeResources>> = {
  small: { requests: { cpu: "1", memory: "4Gi" }, limits: { cpu: "4", memory: "8Gi" } },
  medium: { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "4", memory: "16Gi" } },
  large: { requests: { cpu: "4", memory: "16Gi" }, limits: { cpu: "8", memory: "32Gi" } }
};

export function isVirtualAgentSize(value: unknown): value is VirtualAgentSize {
  return typeof value === "string" && (VIRTUAL_AGENT_SIZES as readonly string[]).includes(value);
}

export type CheckedSize = { ok: true; size: VirtualAgentSize } | { ok: false; error: string };

/** A form that sends no size gets the default; anything else has to be one of the sizes. */
export function checkSize(raw: unknown): CheckedSize {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (value === undefined || value === null || value === "") {
    return { ok: true, size: DEFAULT_SIZE };
  }
  return isVirtualAgentSize(value) ? { ok: true, size: value } : { ok: false, error: `a size is one of ${VIRTUAL_AGENT_SIZES.join(", ")}` };
}

export function sizeLabel(size: VirtualAgentSize): string {
  const { requests, limits } = SIZE_RESOURCES[size];
  const name = `${size[0]!.toUpperCase()}${size.slice(1)}`;
  return `${name}: ${requests.cpu}–${limits.cpu} CPUs, ${requests.memory}–${limits.memory} memory`;
}

/**
 * Why the size cannot be changed now, or `undefined` when it can: only while it is being deleted, which is the same
 * rule a change of plugins has.
 *
 * It does **not** ask whether a pod is running. Size is in the pod template, so a change replaces a running pod — the
 * same mechanism, and the same cost, as a change of plugins, which has always been allowed while running. A rule that
 * required stopping first would make the setting unreachable exactly where it is needed: the Assistant starts its own
 * pod whenever someone opens it, so its owner could never reach a moment at which this answered `undefined`. What
 * keeps that honest is the UI, which says what a change ends before the person commits, not a refusal that leaves
 * them nowhere to go.
 */
export function sizeChangeRefusal(agent: { desired: VirtualAgentDesired; status: VirtualAgentStatus }): string | undefined {
  return agent.desired === "deleted" ? "that virtual agent is being deleted" : undefined;
}

/**
 * Whether changing the size now replaces a pod that is already up, which is what ends the sessions running on it. A
 * pod exists from the moment the orchestrator has acted on a `running` agent, which is every status but `requested` —
 * the same rule `assistantPluginsData` uses for the same question.
 */
export function sizeChangeRollsPod(agent: { desired: VirtualAgentDesired; status: VirtualAgentStatus }): boolean {
  return agent.desired === "running" && agent.status !== "requested";
}
