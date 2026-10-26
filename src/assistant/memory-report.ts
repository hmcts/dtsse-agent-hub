import { CONVERSATION_SESSIONS } from "../orchestrator/manifests.ts";
import { SIZE_RESOURCES, VIRTUAL_AGENT_SIZES, type VirtualAgentSize } from "../virtual-agents/size.ts";

/**
 * What the pod says about its own memory, and whether that is close enough to its ceiling to be worth telling the
 * person about. Pure, and shared by the pod-facing route, the store and the UI, so there is one answer to every
 * question about the pod's memory.
 *
 * The hub cannot see a pod's memory — every call between the two is pod to hub — so everything here is *as of* a
 * report, and the states below exist so that "we have not heard" is never shown as an idle pod. This is the same
 * shape as the uploads report in `upload-report.ts`, for the same reasons; what differs is that the figures come out
 * of the container's own cgroup, which is three small reads rather than a walk of a volume.
 */

/** How often the pod reports, which is the uploads reconcile it rides along with, for wording "when". */
export const MEMORY_REPORT_INTERVAL_MINUTES = 10;

/**
 * What one HMCTS Assistant conversation costs the pod, measured on a live one: the `claude` process is about 310 MB
 * of it and the session's own MCP servers — playwright-mcp, azmcp, mcp-jenkins and their wrappers — are the larger
 * half.
 *
 * It is the unit the warning below is in, because it is the unit the person acts in: they open and close chats, and
 * they choose a size that holds a number of them. A share of the limit would be a round number nobody could check.
 */
export const CONVERSATION_MEMORY_BYTES = Math.round(1.2 * 1024 * 1024 * 1024);

/** A pod's whole report. Every figure is of the container's own cgroup, in bytes. */
export interface MemoryReport {
  /** `memory.max`: where the kernel kills the container. */
  limit_bytes: number;
  /** `memory.current`. */
  current_bytes: number;
  /** `memory.peak`: the high-water mark since the pod booted. */
  peak_bytes: number;
}

/** Why the hub has no figures to show, which is three different things and is told as three. */
export type NoMemoryReport =
  /** The pod runs a client from before it could report, so it will not until it next boots onto a newer one. */
  | "older_client"
  /** The pod is not running, so there is no cgroup to read and nothing has been able to look. */
  | "not_running"
  /** It is running and has simply not reported yet; the first one comes within the reconcile interval. */
  | "waiting";

/** What the Size section knows about the pod's memory: a report, or why there is none. */
export type MemoryUse =
  | {
      reported: true;
      limitBytes: number;
      currentBytes: number;
      peakBytes: number;
      /** When the pod sent it, as an ISO instant. Always shown: these figures are never presented as current. */
      at: string;
      /** The pod is not running now, so nothing will update them until it is. */
      stopped: boolean;
    }
  | { reported: false; reason: NoMemoryReport };

export interface MemoryReportRow {
  memoryLimitBytes: bigint | null;
  memoryCurrentBytes: bigint | null;
  memoryPeakBytes: bigint | null;
  memoryReportedAt: Date | null;
  /** Whether the pod is running now, from the virtual agent's status. */
  running: boolean;
  /** Whether its current session's client claimed the `memory` feature. */
  reports: boolean;
}

/**
 * What to show for the pod's memory. A report is shown whenever there is one, even from a stopped pod — it is still
 * the last thing anyone measured — but it says so, because nothing will move the figures until the pod is back.
 *
 * Without one the pod's state is asked first and its client second, which is `uploadsDisk`'s order and is right for
 * the same reason: a pod that has never been up has no session, so no client to have a claim either way, and
 * "running an older version" would be a guess about it. Once it *is* running, an older client has to come first or
 * it reads as a pod that is merely slow to answer, and the person waits for a report that cannot come.
 */
export function memoryUse(row: MemoryReportRow): MemoryUse {
  if (row.memoryReportedAt !== null && row.memoryLimitBytes !== null && row.memoryCurrentBytes !== null && row.memoryPeakBytes !== null) {
    return {
      reported: true,
      limitBytes: Number(row.memoryLimitBytes),
      currentBytes: Number(row.memoryCurrentBytes),
      peakBytes: Number(row.memoryPeakBytes),
      at: row.memoryReportedAt.toISOString(),
      stopped: !row.running
    };
  }
  if (!row.running) {
    return { reported: false, reason: "not_running" };
  }
  return { reported: false, reason: row.reports ? "waiting" : "older_client" };
}

/** What one size offers, from the constants the orchestrator applies rather than from a second list of figures. */
export interface SizeOffer {
  size: VirtualAgentSize;
  /** How many conversations its pod runs at once, beside its own session. */
  chats: number;
  /** The container's memory request and limit, as the pod template sets them. */
  requests: string;
  limit: string;
}

export function sizeOffer(size: VirtualAgentSize): SizeOffer {
  const resources = SIZE_RESOURCES[size];
  return { size, chats: CONVERSATION_SESSIONS[size], requests: resources.requests.memory, limit: resources.limits.memory };
}

/** Every size, smallest first, as the setting offers them. */
export function sizeOffers(): SizeOffer[] {
  return VIRTUAL_AGENT_SIZES.map(sizeOffer);
}

/** The next size up, or `undefined` on the largest there is, so nothing offers a move that does not exist. */
export function nextSizeUp(size: VirtualAgentSize): VirtualAgentSize | undefined {
  return VIRTUAL_AGENT_SIZES[VIRTUAL_AGENT_SIZES.indexOf(size) + 1];
}

/** Why memory is worth telling the person about, and what they can do: the two facts the wording needs. */
export interface MemoryPressure {
  peakBytes: number;
  limitBytes: number;
  /** Chats with a session running on the pod now, so closing some is offered only when there are some to close. */
  openChats: number;
  /** Where moving up would get them, or `undefined` on the largest size, where closing chats is the only answer. */
  nextSize: SizeOffer | undefined;
}

/**
 * Whether the pod's memory leaves room for another conversation, and the facts for saying so, or `undefined` when it
 * does.
 *
 * **The rule is `peak + one conversation > limit`**, and the boundary is deliberate: a pod with exactly one
 * conversation's worth of headroom still has room for the chat the person is about to open, so it is not warned
 * about. One byte less and it does not.
 *
 * `peak` rather than `current`, because `memory.current` dips between turns: a pod that has twice been within a
 * hundred megabytes of being killed reads as comfortable whenever nothing is mid-answer, which is most of the time
 * anyone looks. The peak is monotonic since the pod booted, so a report that is minutes old is a lower bound on it —
 * this understates the pressure and cannot invent it.
 *
 * Nothing is said for a pod with no report: there is no ceiling to measure against, and the three sentences the
 * section shows instead are what honesty about that looks like.
 */
export function memoryPressure(use: MemoryUse, openChats: number, size: VirtualAgentSize): MemoryPressure | undefined {
  if (!use.reported || use.peakBytes + CONVERSATION_MEMORY_BYTES <= use.limitBytes) {
    return undefined;
  }
  const next = nextSizeUp(size);
  return {
    peakBytes: use.peakBytes,
    limitBytes: use.limitBytes,
    openChats,
    nextSize: next === undefined ? undefined : sizeOffer(next)
  };
}

/**
 * The one sentence the settings cog carries for memory, or `null` when there is nothing to carry. It names the
 * assistant's memory rather than the pod or its cgroup, and it is a prompt rather than a failure: nothing here stops
 * anyone chatting in the chats they already have open.
 *
 * Worded here beside the rule, as `connectionsWarning` is, so the cog's label and the section cannot drift.
 */
export function memoryWarning(pressure: MemoryPressure | undefined): string | null {
  return pressure === undefined ? null : "Your assistant is low on memory";
}
