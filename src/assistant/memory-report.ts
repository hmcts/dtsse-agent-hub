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
 * of the container's own cgroup, which is four small reads rather than a walk of a volume.
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
 * What an awake pod holds in `anon` before any conversation: its own session, the three agent-hub daemons and the
 * entrypoint. The mean of 15 samples across two pods on two images, spread 0.91–0.99Gi, which makes it the firmest
 * figure here — the per-conversation marginal above is one transition of one pod.
 *
 * Here as a constant rather than a number in prose because `baseline + cap × conversation` is the whole model of a
 * pod's memory, and it is restated wherever anyone reasons about capacity. Written out, those restatements go stale
 * the moment a cap moves, on a different line, with nothing to catch it. `memory-report.test.ts` turns the one
 * conclusion that matters into an assertion instead.
 */
export const POD_BASELINE_MEMORY_BYTES = Math.round(0.95 * 1024 * 1024 * 1024);

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
 *
 * **Nothing here can tell whose pod a report came from**, so nothing here tries. What keeps a report this pod's is in
 * `virtual-agents/store.ts`: every path that asks for a new or replacement pod drops the report (`NO_MEMORY_REPORT`),
 * and wherever the pod being replaced is still running it drops that pod's launch token too (`NO_TOKEN`), so the old
 * figures go and nothing can put them back. Stopping, deleting and the sweep's auto-stop are not those paths and keep
 * the figures deliberately, though all three bump `pod_generation` too. A pod reports phase `running` before its
 * supervisor starts, so what is left is a gap with no report rather than one with the wrong report.
 *
 * The case none of that covers is a pod replaced without the hub asking — the kubelet restarting one after the OOM
 * kill this warning is about, where no row changed at all. The pod's report as it boots bounds that to the new
 * supervisor's start rather than closing it, and nothing in this function can.
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
 * `anon` is the part the kernel cannot reclaim, it is purely additive, and it is what the constant was measured as in
 * the first place, so it is the figure a headroom question can be asked of at all. `memory.peak` is still reported and
 * still leads the section as the fuller account of what the pod has had to hold; it informs, it does not decide.
 *
 * **What this detects is a pod approaching an OOM kill, not a pod full of chats.** A pod at its cap holds
 * `POD_BASELINE_MEMORY_BYTES + cap × CONVERSATION_MEMORY_BYTES`, and this threshold is `limit − one conversation`, so
 * solving the first past the second puts the meeting point at a cap above
 * `(limit − POD_BASELINE_MEMORY_BYTES − CONVERSATION_MEMORY_BYTES) / CONVERSATION_MEMORY_BYTES` — not quite ten chats
 * on `small` and over twice that on `medium`, which is several times any cap `CONVERSATION_SESSIONS` holds, because
 * the caps are chosen to keep chats inside a size's memory *request* and this sits a conversation under its *limit*,
 * which is double the request.
 *
 * The formula rather than a table of results, deliberately: that bound depends only on the limit and the two
 * constants, so it never moves, where the figures either side of it move with every cap and go stale on a line
 * nothing conflicts with. `memory-report.test.ts` asserts the conclusion for every size at its actual cap, which is
 * the only form of this that a cap change cannot quietly invalidate.
 *
 * **What crosses it is the work inside a chat, not the number of them.** `CONVERSATION_MEMORY_BYTES` is what a
 * session *settles* at, not a ceiling it cannot pass: a build, a dependency tree, a language server or a leak can put
 * one session gigabytes above it, and the pod's own work can do the same. That is the reconciliation between the two
 * things said above — `0.95 + 0.65N` predicts a pod whose sessions are doing what they were measured doing, and this
 * threshold is for when one of them is not. If the additivity held without exception the warning could never fire at
 * any cap, and if the warning fires the additivity has an exception; the exception is work, and it is the thing worth
 * warning about, because it ends in the kernel killing the container and nobody outside the pod can see it coming:
 * the limit is in the pod's cgroup and every call between pod and hub is pod to hub.
 *
 * So `memoryAdvice` must not say the count of chats did this. The honest reading of the threshold is "one
 * conversation's worth from the ceiling", where the conversation is the unit the person thinks in rather than a claim
 * about the cause.
 *
 * **A stopped pod is never warned about.** Nothing clears the last report when a pod stops, and the section still
 * shows it, because it is the last thing anyone measured. But it describes a container that no longer exists, so a
 * pod stopped mid-build at 7.9Gi must not tell its owner the next day that it is low on memory. A *replacement* pod
 * is a different problem with a different fix: the store drops the report rather than this guard catching it, since
 * `running` is true again and the figures would otherwise read as the new pod's.
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
 * The warning in full: what the pod is holding that cannot be freed up, and what a bigger size would give it.
 *
 * **It does not say the person's chats did this, and it does not offer closing one as the cure.** A pod's whole
 * complement of chats cannot reach this threshold at any size or cap — `memoryPressure` has the arithmetic — so when
 * this fires, `cap × CONVERSATION_MEMORY_BYTES` is a fraction of what is being held and closing one chat would not
 * change the answer. A bigger size is the remedy, because it doubles the limit the pod is running into. The per-chat
 * figure is still worth giving someone deciding what to do, so it is stated as a quantity rather than as the thing
 * to do, and left out when no chat is open to close, where it would be a fact about nothing.
 *
 * **"holding", not "reached".** The section's first line already says what the pod reached at its busiest, which is a
 * bigger number than this one; two sentences using the same verb for two different figures, the second smaller, reads
 * as one of them being wrong.
 */
export function memoryAdvice(pressure: MemoryPressure): string {
  const said = [
    `It is holding ${describeSize(pressure.anonBytes)} of its ${describeSize(pressure.limitBytes)} in memory that cannot be freed up, which leaves less than another chat's worth spare.`,
    pressure.nextSize === undefined
      ? "This is the largest size there is."
      : `Move up to ${pressure.nextSize.size} below for ${offerMemory(pressure.nextSize)} of memory and ${pressure.nextSize.chats} chats at once.`
  ];
  if (pressure.openChats > 0) {
    said.push(`Closing a chat frees about ${describeChatCost()} of it.`);
  }
  return said.join(" ");
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
