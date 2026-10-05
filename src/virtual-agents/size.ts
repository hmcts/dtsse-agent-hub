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
 * Why the size cannot be changed now, or `undefined` when it can: only before the orchestrator has made the pod, or
 * once it has stopped, so a change never restarts a pod someone is working in.
 */
export function sizeChangeRefusal(agent: { desired: VirtualAgentDesired; status: VirtualAgentStatus }): string | undefined {
  if (agent.desired === "deleted") {
    return "that virtual agent is being deleted";
  }
  if (agent.status === "requested" || agent.status === "stopped") {
    return undefined;
  }
  return "stop the virtual agent before changing its size";
}
