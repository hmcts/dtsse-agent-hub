import type { VirtualAgentStatus } from "../virtual-agents/lifecycle.ts";

/**
 * The lines the getting-ready screen rotates while someone waits for their assistant's pod. They are keyed by what
 * the pod is doing, so the joke matches the step shown beside it: the two steps the screen waits through are the
 * start and the clone, and each pool is that step's own lines followed by the ones that fit either.
 */

export type WarmupPhase = "starting" | "cloning";

/** Lines that fit whatever the pod is doing, and carry a wait that is dragging on; every pool ends with them. */
export const WARMUP_GENERAL: readonly string[] = [
  "Still going. Nothing's broken.",
  "Not stuck, just thorough.",
  "Nearly there. Biscuit?",
  "Won't be long now."
];

const WARMUP_MESSAGES: Readonly<Record<WarmupPhase, readonly string[]>> = {
  starting: [
    "Warming up. Go and grab a cuppa.",
    "Putting the kettle on.",
    "Rummaging about in the cloud for a spare machine.",
    "Finding your assistant a desk.",
    "Waking your assistant. It isn't a morning person.",
    "Queueing, politely.",
    ...WARMUP_GENERAL
  ],
  cloning: [
    "Cloning the workspace — all of it, I'm afraid.",
    "Reading rather a lot of CLAUDE.md files.",
    "Memorising the acronyms. There are a great many.",
    "Working out what SSCS stands for.",
    ...WARMUP_GENERAL
  ]
};

/** Every 6 seconds: long enough to read a line, short enough that the screen looks alive. */
export const WARMUP_ROTATE_MS = 6_000;

/** After three minutes the wait has stopped being funny, so the screen says so instead. */
export const WARMUP_PATIENCE_MS = 3 * 60_000;

export const WARMUP_SIGNPOST = "This usually takes a couple of minutes.";

export const WARMUP_SLOW = "This is taking longer than usual. It's still trying.";

/**
 * Which pool fits what the pod is doing. Cloning the workspace is the one step long enough to deserve its own lines;
 * everything else the screen waits through is the assistant starting. A status the screen shows no line for at all —
 * it failed, or it is asking the person to sign in — never reaches a pool.
 */
export function warmupPhase(status: VirtualAgentStatus): WarmupPhase {
  return status === "cloning" ? "cloning" : "starting";
}

/**
 * The statuses where the pod is blocked on the person rather than getting on with it: it has relayed a sign-in and
 * is waiting for a code or a credential. They have no lines of their own, because they never reach the warming-up
 * screen — the person is sent to the connections, where they can act on the sign-in, and reading a joke is not what
 * they need.
 */
const WAITING_ON_PERSON: readonly VirtualAgentStatus[] = ["awaiting_credentials", "awaiting_login"];

export function waitingForPerson(status: VirtualAgentStatus): boolean {
  return WAITING_ON_PERSON.includes(status);
}

export function warmupPool(phase: WarmupPhase): readonly string[] {
  return WARMUP_MESSAGES[phase];
}

/** The step's own first line, which the server renders, so both sides of hydration agree and the line fits the step. */
export function firstWarmupMessage(phase: WarmupPhase): string {
  return warmupPool(phase)[0] as string;
}

/**
 * One of a non-empty pool, chosen by a random value in [0, 1), never the line showing — unless the pool has nothing
 * else, in which case it stays put rather than failing.
 */
export function pickMessage(pool: readonly string[], previous: string, random: number): string {
  const others = pool.filter((message) => message !== previous);
  const choices = others.length === 0 ? pool : others;
  const index = Math.min(Math.floor(random * choices.length), choices.length - 1);
  return choices[index] as string;
}

/** The next line for a phase, given the one showing and a random value in [0, 1). */
export function nextWarmupMessage(phase: WarmupPhase, previous: string, random: number): string {
  return pickMessage(warmupPool(phase), previous, random);
}
