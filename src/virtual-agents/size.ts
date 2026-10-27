import type { VirtualAgentDesired, VirtualAgentStatus } from "./lifecycle.ts";

/**
 * How much CPU and memory a virtual agent's pod gets. The orchestrator turns a size into the container's resources;
 * the page describes each size from the same table.
 *
 * **There is no CPU limit.** What a pod is guaranteed when a node is contended comes from `cpu.shares`, which the
 * CPU **request** sets and which is kept; a quota adds nothing to that floor and only clips the bursts above it. One
 * session alone averaged 568m over its busiest 30s and was still throttled in 26 of that window's periods against a
 * four-CPU quota, so every Assistant conversation was paying latency for a ceiling that protected nothing — unlike
 * memory, which keeps its limit, throttling has no OOM-kill equivalent to be protected from.
 *
 * A quota is not thereby wrong in principle: its job is to bound the blast radius of a runaway pod, and a round
 * multiple of the request would be a defensible way to pick one. It is set aside rather than refuted, because
 * nothing measured here can size it — a CFS quota is CPU-seconds per 100ms period and every figure measured is a
 * mean over a window of seconds, which is why a session averaging 0.57 CPU was throttled against 4.0.
 *
 * So a size steps up what it guarantees rather than what it may borrow, and `CONVERSATION_SESSIONS` sets how many
 * Assistant conversations each size's pod runs against those requests.
 */

export const VIRTUAL_AGENT_SIZES = ["small", "medium", "large"] as const;

export type VirtualAgentSize = (typeof VIRTUAL_AGENT_SIZES)[number];

export const DEFAULT_SIZE: VirtualAgentSize = "small";

export interface SizeResources {
  requests: { cpu: string; memory: string };
  /** Memory alone: the type carries no `cpu`, so nothing can put a quota back without saying why above. */
  limits: { memory: string };
}

export const SIZE_RESOURCES: Readonly<Record<VirtualAgentSize, SizeResources>> = {
  small: { requests: { cpu: "1", memory: "4Gi" }, limits: { memory: "8Gi" } },
  medium: { requests: { cpu: "2", memory: "8Gi" }, limits: { memory: "16Gi" } },
  large: { requests: { cpu: "4", memory: "16Gi" }, limits: { memory: "32Gi" } }
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

/**
 * How a size reads on the page. CPU is "from", because the request is a floor the pod bursts above rather than a
 * range it is held inside; memory is a range, because it has a ceiling the kernel enforces.
 */
export function sizeLabel(size: VirtualAgentSize): string {
  const { requests, limits } = SIZE_RESOURCES[size];
  const name = `${size[0]!.toUpperCase()}${size.slice(1)}`;
  const cpus = `${requests.cpu} CPU${requests.cpu === "1" ? "" : "s"}`;
  return `${name}: from ${cpus}, ${requests.memory}–${limits.memory} memory`;
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
