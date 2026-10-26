import { CONVERSATION_SESSIONS } from "../orchestrator/manifests.ts";
import { SIZE_RESOURCES, VIRTUAL_AGENT_SIZES, type VirtualAgentSize } from "../virtual-agents/size.ts";
import { describeSize } from "./upload-report.ts";

/**
 * What the pod says about its own memory, whether that is close enough to its ceiling to be worth telling the person
 * about, and the sentences the settings' Size section says either way. Pure, and shared by the pod-facing route, the
 * store and the UI, so there is one answer to every question about the pod's memory — and the words are here beside
 * the rules they describe, so a threshold and the sentence about it cannot drift.
 *
 * The hub cannot see a pod's memory — every call between the two is pod to hub — so everything here is *as of* a
 * report, and the states below exist so that "we have not heard" is never shown as an idle pod. This is the same
 * shape as the uploads report in `upload-report.ts`, for the same reasons; what differs is that the figures come out
 * of the container's own cgroup, which is three small reads rather than a walk of a volume.
 */

/** How often the pod reports, which is the uploads reconcile it rides along with, for wording "when". */
export const MEMORY_REPORT_INTERVAL_MINUTES = 10;

/**
 * What one HMCTS Assistant conversation costs the pod: about 0.65Gi, the drop in the container cgroup's
 * `memory.stat` `anon` when a preview pod went from two sessions to one. The same subtraction of every process's
 * proportional set size puts it at 0.68Gi, and of `memory.current` at 0.69Gi. The session's own MCP servers —
 * playwright-mcp, azmcp, mcp-jenkins and their wrappers — are about half of it, `claude` itself under a third, and
 * agent-hub's bridge and `hai` the rest.
 *
 * **PSS, not RSS.** A session is twenty-odd node processes sharing one node binary and their `node_modules` pages;
 * ΣRSS counts those pages once per process and puts the same marginal at 1.25Gi, nearly double. The MCP servers'
 * heaps are their own, so what sharing there is buys less than it looks like it should.
 *
 * It is the unit the warning below is in, because it is the unit the person acts in: they open and close chats, and
 * they choose a size that holds a number of them. A share of the limit would be a round number nobody could check.
 */
export const CONVERSATION_MEMORY_BYTES = Math.round(0.65 * 1024 * 1024 * 1024);

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
 * `peak` counts the container's page cache as well as its heaps, and on the pods `CONVERSATION_MEMORY_BYTES` was
 * measured on that cache was 2.1–2.4Gi of the workspace clone, so the peak sits well above the part of the pod the
 * kernel cannot reclaim. The constant is still the right one to compare against it: a conversation moved
 * `memory.current` by 0.69Gi and the page cache within it by 0.03Gi, so one more chat costs about the same 0.65Gi
 * whichever of the two the comparison is in. What the cache costs is sensitivity — a pod that has merely read a lot
 * of files reaches the threshold earlier than its heaps alone would — and closing that gap needs a figure for the
 * non-reclaimable part, which the pod's three cgroup reads do not include.
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

/**
 * The warning in full: where the pod got to, and what to do about it.
 *
 * Both answers are offered when there is a bigger size and more than one chat open. On the largest size there is no
 * bigger one, and with a single chat open "close a chat" would be an instruction to stop working — so neither is
 * offered where it would be no use. Telling someone memory is low and leaving them nowhere to go is the thing this
 * section exists not to do, which is why the advice is part of the same sentence rather than a separate kindness.
 */
export function memoryAdvice(pressure: MemoryPressure): string {
  const reached = `It has reached ${describeSize(pressure.peakBytes)} of its ${describeSize(pressure.limitBytes)}, which leaves no room for another chat.`;
  const bigger = pressure.nextSize;
  if (bigger === undefined) {
    return `${reached} This is the largest size there is, so close a chat you have finished with before you start another.`;
  }
  const orClose = pressure.openChats > 1 ? ", or close a chat you have finished with" : "";
  return `${reached} Move up to ${bigger.size} below for ${bigger.chats} chats at once and ${bigger.limit} of memory${orClose}.`;
}

/** The chats a change of size would stop, as the question names them. */
function chatsStopped(openChats: number): string {
  if (openChats === 0) {
    return "whatever it is working on";
  }
  if (openChats === 1) {
    return "the one chat you have open";
  }
  return `all ${openChats} chats you have open`;
}

/**
 * What a change of size is going to do, asked before it is made.
 *
 * Size is in the pod template, so a change replaces a running pod and every conversation session on it stops where it
 * is. `rollsPod` is the difference between that and a pod the orchestrator has not made yet, which simply starts at
 * the new size — and saying the first of those as if it were the second is the one thing this must not do.
 */
export function sizeChangeQuestion(size: string, rollsPod: boolean, openChats: number): string {
  return rollsPod
    ? `Change to ${size}? Your assistant restarts, which stops ${chatsStopped(openChats)}.`
    : `Change to ${size}? Your assistant starts at the new size the next time you use it.`;
}
