import { z } from "zod";

/**
 * A .pptx built on the owner's request from a deck version that keeps none, by the conversation's own pod: only the
 * pod has the slides plugin, so the hub never builds one itself. See "Deck builds" in docs/agent-api.md.
 */

/** The slides plugin, which the owner ticks and a pod needs to build anything. */
export const SLIDES_PLUGIN = "slides";

export const SLIDES_NOT_TURNED_ON = "turn on Slides in Settings, under Tools, first";

/** How long the hub waits for the pod's answer; the pod gives itself 14 minutes, so an answer is never thrown away. */
export const DECK_BUILD_TIMEOUT_MS = 15 * 60_000;

/**
 * How long a built .pptx is kept, from when it was asked for. Separate from the latest-3 rule on versions, which
 * bounds what every deck holds; this bounds only what a person asked for, and long enough to download it again.
 */
export const DECK_BUILD_KEEP_MS = 24 * 60 * 60_000;

/** The finished builds a conversation keeps, newest first, so asking for every version in turn holds at most this many. */
export const DECK_BUILDS_KEPT = 10;

export const MAX_DECK_BUILD_ERROR = 2000;

export type DeckBuildStatus = "pending" | "done" | "failed" | "timeout";

/** What asking for a build answers: the bytes are there already, a build to read back, or why none was started. */
export type DeckBuildRequest =
  | { status: "ready" }
  | { status: "pending"; job_id: string }
  | { status: "waking" }
  | { status: "unsupported" }
  | { status: "no_pod" };

/** What reading a build back answers. */
export interface DeckBuildView {
  status: DeckBuildStatus;
  job_id: string;
  version: number;
  error?: string;
}

/** The pod's `{error}` answer; the bytes come as the body instead. */
export const deckBuildErrorBody = z.strictObject({ error: z.string().trim().min(1).max(MAX_DECK_BUILD_ERROR) });

/** The status a row reads as now: a build left pending past its time has timed out, whatever the row still says. */
export function buildStatus(row: { status: string; createdAt: Date }, now: Date): DeckBuildStatus {
  if (row.status === "pending") {
    return now.getTime() - row.createdAt.getTime() >= DECK_BUILD_TIMEOUT_MS ? "timeout" : "pending";
  }
  return row.status === "done" || row.status === "failed" ? row.status : "timeout";
}

/** A version number from a path segment: a whole number from 1, as the deck's own routes take it. */
export function versionParam(raw: string | null | undefined): number | undefined {
  return typeof raw === "string" && /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : undefined;
}
