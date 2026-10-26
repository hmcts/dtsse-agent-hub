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
 * **It rests on one transition of one `small` pod.** The three routes above are that single subtraction read three
 * ways, not three measurements, so their agreement says the arithmetic is sound and nothing about variance between
 * pods or over time. Only the 0.95Gi baseline it sits on top of has a sample behind it — 15, across two pods and two
 * images, spread 0.91–0.99Gi. Widening a cap on this figure wants a pod with several conversations measured first.
 *
 * It is the unit the warning below is in, because it is the unit the person acts in: they open and close chats, and
 * they choose a size that holds a number of them. A share of the limit would be a round number nobody could check.
 */
export const CONVERSATION_MEMORY_BYTES = Math.round(0.65 * 1024 * 1024 * 1024);

/**
 * That cost as a sentence says it: `0.65 GB`. Two decimal places at most, and in the gigabytes the rest of the Size
 * section is already in, so a sentence about a chat does not change unit from the sentence above it.
 *
 * Not `describeSize`, which is the formatter for a file on a disk and would say `665.6 MB` — a tenth of a megabyte,
 * claimed for a figure rounded off one measurement. The precision a figure is shown to is a claim about it.
 */
export function describeChatCost(): string {
  return `${Number((CONVERSATION_MEMORY_BYTES / 1024 ** 3).toFixed(2))} GB`;
}

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

/**
 * The memory a size offers, as the person reads it: the request it is guaranteed through to the limit the kernel
 * kills it at. Both, because each answers a different question — the cap below comes from the request, and the
 * warning above measures the pod's peak against the limit, so naming only one leaves the other figure unexplained
 * where it appears.
 */
export function offerMemory(offer: SizeOffer): string {
  return `${offer.requests}–${offer.limit}`;
}

/**
 * How many chats the pod in front of the person actually runs at once: the figure it reported, and the size's
 * constant only until it has reported one.
 *
 * **The constant on its own would be a lie with a cost.** A cap is baked into the pod template as
 * `AGENT_HUB_MAX_SESSIONS`, and nothing claims an agent whose generation has not moved, so raising the constant
 * reaches a running pod when it next rolls and not before. A pod already at its cap does not queue the next wake: its
 * supervisor stops the least recently active idle session to make room. So a figure read from the constant during
 * that window invites someone to open a chat that silently ends one they never closed.
 *
 * The pod sends `max` with every sessions report, at least once a minute, so the fallback is the first minute of a
 * pod's life and pods too old to report sessions at all.
 */
export function podChats(reportedMax: number | null, size: VirtualAgentSize): number {
  return reportedMax ?? CONVERSATION_SESSIONS[size];
}

/** What a pod will hold once it next restarts, or `undefined` when that is what it holds already. */
export function chatsAfterRestart(reportedMax: number | null, size: VirtualAgentSize): number | undefined {
  const cap = CONVERSATION_SESSIONS[size];
  return podChats(reportedMax, size) === cap ? undefined : cap;
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
  /** The figure the threshold was crossed on, which is the live one rather than the peak. */
  currentBytes: number;
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
 * **The rule is `current + one conversation > limit`**, and the boundary is deliberate: a pod with exactly one
 * conversation's worth of headroom still has room for the chat the person is about to open, so it is not warned
 * about. One byte less and it does not.
 *
 * **`current` rather than `peak`, because the warning has to be able to clear.** `memory.peak` is monotonic for the
 * life of the pod — the pod reads it and nothing resets it — so a threshold crossed once is crossed again by every
 * later report, and closing a chat, the first thing the advice offers, could never undo it. Only replacing the pod
 * could, which made one of the two remedies work by side effect and the other not at all. `memory.current` falls by
 * about one conversation when a session ends, so the action the person is asked to take is the action that clears
 * the warning. The cost is that `current` dips between turns and a report is up to ten minutes old, so a stale one
 * can overstate as well as understate, where a stale peak could only understate — and a figure that cannot come down
 * at all is the worse of the two. `memory.peak` is still reported and still shown, as what the pod reached at its
 * busiest: it informs, it does not decide.
 *
 * **This threshold is not reachable by opening chats, at any size.** `current` counts the container's page cache,
 * which was 2.1–2.4Gi of the workspace clone on the pods the constant was measured on, and the caps sit far below
 * what the limits allow: a `small` pod at its cap of 4 settles near 6.2Gi of its 8Gi against a threshold of 7.35Gi,
 * and the gap is wider on every larger size. So what trips this is page cache or the pod's own work rather than a
 * person's chats, which is why `memoryAdvice` says what was measured and what each remedy frees instead of naming
 * chats as the cause. Closing the gap needs a figure for the part the kernel cannot reclaim, which the pod's three
 * cgroup reads do not include.
 *
 * Nothing is said for a pod with no report: there is no ceiling to measure against, and the three sentences the
 * section shows instead are what honesty about that looks like.
 */
export function memoryPressure(use: MemoryUse, openChats: number, size: VirtualAgentSize): MemoryPressure | undefined {
  if (!use.reported || use.currentBytes + CONVERSATION_MEMORY_BYTES <= use.limitBytes) {
    return undefined;
  }
  const next = nextSizeUp(size);
  return {
    currentBytes: use.currentBytes,
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
 * The warning in full: what the pod reached, and what each thing the person can do would free.
 *
 * **It does not say their chats filled the pod.** This threshold is not reachable by opening chats at any size — see
 * `memoryPressure` — so what is behind it is page cache or the pod's own work, and naming chats as the cause would
 * be a diagnosis the figures contradict. What each remedy frees is a fact, and it still leaves the person somewhere
 * to go, which is what this section exists to do.
 *
 * Both remedies are offered when there is a bigger size and more than one chat open. On the largest size there is no
 * bigger one, and with a single chat open "close a chat" would be an instruction to stop working — so neither is
 * offered where it would be no use.
 */
export function memoryAdvice(pressure: MemoryPressure): string {
  const reached = `It has reached ${describeSize(pressure.currentBytes)} of its ${describeSize(pressure.limitBytes)}, which leaves less than another chat's worth free.`;
  const closing = `close a chat you have finished with to free about ${describeChatCost()}`;
  const bigger = pressure.nextSize;
  if (bigger === undefined) {
    return `${reached} This is the largest size there is, so ${closing}.`;
  }
  const orClose = pressure.openChats > 1 ? `, or ${closing}` : "";
  return `${reached} Move up to ${bigger.size} below for ${bigger.chats} chats at once and ${offerMemory(bigger)} of memory${orClose}.`;
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
