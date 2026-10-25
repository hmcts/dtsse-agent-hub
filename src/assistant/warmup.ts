import type { VirtualAgentStatus } from "../virtual-agents/lifecycle.ts";

/**
 * The lines the getting-ready screen rotates while someone waits for their assistant's pod. They are keyed by what
 * the pod is doing, so the joke matches the step shown beside it, and a phase with nothing of its own falls back to
 * the lines that fit any of them.
 */

export type WarmupPhase = "starting" | "signing_in" | "cloning" | "any";

/** Lines that fit any phase, and the pool for a phase with none of its own. */
export const WARMUP_ANY: readonly string[] = ["Still going. Nothing's broken.", "Not stuck, just thorough.", "Nearly there. Biscuit?", "Won't be long now."];

const WARMUP_MESSAGES: Readonly<Partial<Record<WarmupPhase, readonly string[]>>> = {
  starting: [
    "Warming up. Go and grab a cuppa.",
    "Putting the kettle on.",
    "Rummaging about in the cloud for a spare machine.",
    "Finding your assistant a desk.",
    "Waking your assistant. It isn't a morning person.",
    "Queueing, politely."
  ],
  signing_in: ["Having a quick word with Azure.", "Asking IDAM nicely."],
  cloning: [
    "Cloning the workspace — all of it, I'm afraid.",
    "Reading rather a lot of CLAUDE.md files.",
    "Memorising the acronyms. There are a great many.",
    "Working out what SSCS stands for."
  ]
};

/** Every 6 seconds: long enough to read a line, short enough that the screen looks alive. */
export const WARMUP_ROTATE_MS = 6_000;

/** After three minutes the wait has stopped being funny, so the screen says so instead. */
export const WARMUP_PATIENCE_MS = 3 * 60_000;

export const WARMUP_SIGNPOST = "This usually takes a couple of minutes.";

export const WARMUP_SLOW = "This is taking longer than usual. It's still trying.";

export function warmupPhase(status: VirtualAgentStatus): WarmupPhase {
  switch (status) {
    case "requested":
    case "provisioning":
    case "stopping":
    case "stopped":
      return "starting";
    case "awaiting_credentials":
    case "awaiting_login":
      return "signing_in";
    case "cloning":
      return "cloning";
    default:
      return "any";
  }
}

export function warmupPool(phase: WarmupPhase): readonly string[] {
  return WARMUP_MESSAGES[phase] ?? WARMUP_ANY;
}

/** What the server renders, so the first line is the same on both sides of hydration. */
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
