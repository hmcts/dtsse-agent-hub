import type { ApiMessage } from "./shape.ts";

/**
 * Keyset pages over a feed shown oldest at the top. A page is read with one extra row, so whether an older page
 * exists is known without a count; "load older" then asks for the posts before the oldest one shown.
 */

export const FEED_PAGE_SIZE = 30;

export interface FeedPageView {
  /** Oldest first. */
  messages: ApiMessage[];
  /** The id to ask for posts before, or `null` when this page reaches the start of the feed. */
  olderBefore: string | null;
}

/** `rows` is up to `limit + 1` messages, oldest first, as read with `limit + 1`. */
export function toPage(rows: readonly ApiMessage[], limit: number = FEED_PAGE_SIZE): FeedPageView {
  const messages = rows.length > limit ? rows.slice(rows.length - limit) : [...rows];
  return { messages, olderBefore: rows.length > limit && messages.length > 0 ? messages[0]!.id : null };
}

function byId(left: { id: string }, right: { id: string }): number {
  const a = BigInt(left.id);
  const b = BigInt(right.id);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every message in either list once, oldest first. Live events, a page of older posts and the composer's own
 * result can all carry the same message; the later copy wins, because it carries the newer delivery state.
 */
export function mergeMessages<M extends { id: string }>(existing: readonly M[], incoming: readonly M[]): M[] {
  const byKey = new Map<string, M>();
  for (const message of [...existing, ...incoming]) {
    byKey.set(message.id, message);
  }
  return [...byKey.values()].sort(byId);
}
