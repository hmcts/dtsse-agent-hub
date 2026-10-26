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
  /** `memory.stat`'s `anon`: the part the kernel cannot reclaim, which the warning is computed from. */
  anon_bytes: number;
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
      anonBytes: number;
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
  memoryAnonBytes: bigint | null;
  memoryReportedAt: Date | null;
  /** Whether the pod is running now, from the virtual agent's status. */
  running: boolean;
  /** Whether its current session's client claimed the `memory-anon` feature, which is what makes a report possible. */
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
  if (
    row.memoryReportedAt !== null &&
    row.memoryLimitBytes !== null &&
    row.memoryCurrentBytes !== null &&
    row.memoryPeakBytes !== null &&
    row.memoryAnonBytes !== null
  ) {
    return {
      reported: true,
      limitBytes: Number(row.memoryLimitBytes),
      currentBytes: Number(row.memoryCurrentBytes),
      peakBytes: Number(row.memoryPeakBytes),
      anonBytes: Number(row.memoryAnonBytes),
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

/** How many chats a pod runs at once: what it is running now, and what a restart would change that to. */
export interface ChatCapacity {
  /** What it is running now, or `undefined` when there is no answer the hub can honestly give. */
  now: number | undefined;
  /** What its size's cap will give it from its next restart, or `undefined` when that is what it runs already. */
  fromRestart: number | undefined;
}

/**
 * What may be said about how many chats a pod runs, from the `max` it reports, whether it is running, and its size's
 * cap. Both facts come back together so that no surface has to invent the one it is missing.
 *
 * **The cap alone would be a figure with a cost behind it.** A cap is baked into the pod template as
 * `AGENT_HUB_MAX_SESSIONS`, and nothing claims an agent whose generation has not moved, so raising
 * `CONVERSATION_SESSIONS` reaches a running pod when it next rolls and not before. A pod already at its cap does not
 * queue the next wake: its supervisor stops the least recently active idle session to make room. So a cap shown as
 * what a pod runs now invites someone to open a chat that silently ends one they never closed.
 *
 * **There is no `now` for a pod that has not reported one.** The hub cannot see a pod's supervisor, so there is
 * nothing to fall back *to*: the cap is what the pod will be given, not what it was given, and the two differ for
 * exactly as long as the mismatch above lasts. The pod sends `max` with every sessions report, at least once a
 * minute, so this is the first minute of a pod's life and pods on a client too old to report sessions at all.
 *
 * **Nor for a pod that is not running**, whatever it last reported. A stopped pod runs no chats at all, so any figure
 * in the present tense is false — and its last `max` is never cleared, so it outlives both the pod that sent it and
 * any size change made while it was stopped. That last one is the trap: a `small` pod stopped at `max: 4` and then
 * resized to `medium` would have its dead cap read back as `medium`'s. This is the same care `memoryUse` takes with
 * `stopped` and `memoryPressure` with refusing to warn, for the same reason — the figures describe a container that
 * no longer exists. `fromRestart` is what such a pod can honestly be said to hold, and is what it will hold.
 */
export function chatCapacity(reportedMax: number | null, size: VirtualAgentSize, running: boolean): ChatCapacity {
  const cap = CONVERSATION_SESSIONS[size];
  if (reportedMax === null || !running) {
    return { now: undefined, fromRestart: cap };
  }
  return { now: reportedMax, fromRestart: reportedMax === cap ? undefined : cap };
}

/**
 * The sentence the Size section says about the size the person is on.
 *
 * Worded here beside `chatCapacity`, as `memoryAdvice` is beside its threshold, because which sentence is said *is*
 * the rule: a pod with no honest answer for what it runs now — it has not reported, or it is not running — has to be
 * described without that number, and a sentence assembled in the component could not help naming it. That the pod is
 * stopped is said by the figures below rather than repeated here.
 */
export function sizeSentence(size: VirtualAgentSize, capacity: ChatCapacity): string {
  const offer = sizeOffer(size);
  const memory = `${offerMemory(offer)} of memory`;
  const chats = capacity.now === undefined ? `You are on ${size}, with ${memory}.` : `You are on ${size}: ${capacity.now} chats at once, ${memory}.`;
  const restart = capacity.fromRestart === undefined ? "" : ` It holds ${capacity.fromRestart} chats at once from its next restart.`;
  return `${chats}${restart}`;
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
  /** The figure the threshold was crossed on, which is the part that cannot be reclaimed. */
  anonBytes: number;
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
 * **The rule is `anon + one conversation > limit`**, and the boundary is deliberate: a pod with exactly one
 * conversation's worth of headroom still has room for the chat the person is about to open, so it is not warned
 * about. One byte less and it does not.
 *
 * **`anon`, because it is the only figure the warning's sentence can be true of.** `memory.current` and
 * `memory.peak` both count page cache, and that was 2.1–2.4Gi of the 6.8GiB workspace clone on the pods
 * `CONVERSATION_MEMORY_BYTES` was measured on. Cache is reclaimed at the `memory.max` watermark rather than given
 * back, so a container that has read the clone sits high and stays high: a threshold on either figure is crossed by
 * file reads, and in that case there *is* room for another chat, so "leaves less than another chat's worth free"
 * would be false exactly when it appeared. Neither is rescued by choosing the constant differently, because the
 * problem is what the figure tracks rather than its scale.
 *
 * `anon` is the part the kernel cannot reclaim, it is purely additive, a session starting or ending moves it by about
 * one conversation and nothing else moves it much — 15 samples of a working pod held within 3% — and it is what the
 * constant was measured as in the first place. So the threshold is reachable by opening chats, which is what the
 * warning says, and it falls again when one is closed, so the remedy the advice offers is the remedy that clears it.
 * `memory.peak` is still reported and still leads the section as the fuller account of what the pod has had to hold;
 * it informs, it does not decide.
 *
 * **A stopped pod is never warned about.** Nothing clears the last report when a pod stops, and the section still
 * shows it, because it is the last thing anyone measured. But it describes a container that no longer exists: a pod
 * stopped mid-build at 7.9Gi must not tell its owner the next day that it is low on memory, and a pod just restarted
 * must not carry the old pod's warning for the ten minutes before the new one reports.
 *
 * Nothing is said for a pod with no report either: there is no ceiling to measure against, and the three sentences
 * the section shows instead are what honesty about that looks like.
 */
export function memoryPressure(use: MemoryUse, openChats: number, size: VirtualAgentSize): MemoryPressure | undefined {
  if (!use.reported || use.stopped || use.anonBytes + CONVERSATION_MEMORY_BYTES <= use.limitBytes) {
    return undefined;
  }
  const next = nextSizeUp(size);
  return {
    anonBytes: use.anonBytes,
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
 * The warning in full: what the pod is holding, and what each thing the person can do would free.
 *
 * **"holding", not "reached", and the `anon` figure rather than the peak.** The section's first line already says
 * what the pod reached at its busiest, which is a bigger number than this one; two sentences using the same verb for
 * two different figures, the second smaller, reads as one of them being wrong. This names what it is counting
 * instead.
 *
 * **Closing a chat is offered only when there is one to close that is not the one in use.** With a single chat open
 * it would be an instruction to stop working, and with none it would name something the person does not have — which
 * matters more now the sentence promises a specific amount for doing it. On the largest size there is no bigger size
 * to offer either, so when neither remedy applies the warning is the measurement alone: there is nothing useful to
 * suggest, and inventing one would be worse than saying so.
 */
export function memoryAdvice(pressure: MemoryPressure): string {
  const holding = `Its chats and tools are holding ${describeSize(pressure.anonBytes)} of its ${describeSize(pressure.limitBytes)}, which leaves less than another chat's worth free.`;
  const closing = pressure.openChats > 1 ? `close a chat you have finished with to free about ${describeChatCost()}` : undefined;
  const bigger = pressure.nextSize;
  if (bigger === undefined) {
    return closing === undefined ? holding : `${holding} This is the largest size there is, so ${closing}.`;
  }
  const orClose = closing === undefined ? "" : `, or ${closing}`;
  return `${holding} Move up to ${bigger.size} below for ${bigger.chats} chats at once and ${offerMemory(bigger)} of memory${orClose}.`;
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
