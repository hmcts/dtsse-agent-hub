import type { FeedbackRecordingStatus, FeedbackRecordingView } from "./recording-store.ts";
import type { FeedbackThreadStatus, FeedbackThreadView } from "./thread-store.ts";

/**
 * What the team's project page derives from the threads and recordings it was given: the counts, the activity, the
 * reviewers, and the order the comments view lays a page's threads out in. Pure, so the page renders what these say.
 */

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ThreadCounts {
  open: number;
  resolved: number;
  detached: number;
}

export function threadCounts(threads: readonly Pick<FeedbackThreadView, "status">[]): ThreadCounts {
  const counts: ThreadCounts = { open: 0, resolved: 0, detached: 0 };
  for (const thread of threads) {
    counts[thread.status] += 1;
  }
  return counts;
}

export interface ThreadFilter {
  linkId: string | null;
  pagePath: string | null;
  authorOid: string | null;
  status: FeedbackThreadStatus | null;
}

export const NO_FILTER: ThreadFilter = { linkId: null, pagePath: null, authorOid: null, status: null };

/** The threads the rail's filters leave. A page is matched only once a link is, since two links can share a path. */
export function filterThreads<T extends FeedbackThreadView>(threads: readonly T[], filter: ThreadFilter): T[] {
  return threads.filter(
    (thread) =>
      (filter.linkId === null || thread.linkId === filter.linkId) &&
      (filter.pagePath === null || thread.pagePath === filter.pagePath) &&
      (filter.authorOid === null || thread.author.oid === filter.authorOid) &&
      (filter.status === null || thread.status === filter.status)
  );
}

export interface PageGroup {
  linkId: string;
  pagePath: string;
  threads: number;
}

/** Each page with threads, per link, in path order, with how many threads it has. */
export function pagesOf(threads: readonly Pick<FeedbackThreadView, "linkId" | "pagePath">[]): PageGroup[] {
  const pages = new Map<string, PageGroup>();
  for (const thread of threads) {
    const key = `${thread.linkId} ${thread.pagePath}`;
    const page = pages.get(key) ?? { linkId: thread.linkId, pagePath: thread.pagePath, threads: 0 };
    page.threads += 1;
    pages.set(key, page);
  }
  return [...pages.values()].sort((a, b) => byCodePoint(a.linkId, b.linkId) || byCodePoint(a.pagePath, b.pagePath));
}

/**
 * A page's threads down its margin: those still on the page in the order their elements are down it, then by when
 * they were raised; detached ones are laid out apart, having no element to sit beside.
 */
export function marginOrder<T extends Pick<FeedbackThreadView, "status" | "anchor" | "createdAt" | "id">>(
  threads: readonly T[]
): { onPage: T[]; detached: T[] } {
  const ordered = [...threads].sort(
    (a, b) => a.anchor.rect.y - b.anchor.rect.y || a.anchor.rect.x - b.anchor.rect.x || byCodePoint(a.createdAt, b.createdAt) || byCodePoint(a.id, b.id)
  );
  return { onPage: ordered.filter((thread) => thread.status !== "detached"), detached: ordered.filter((thread) => thread.status === "detached") };
}

export interface Reviewer {
  oid: string;
  name: string;
  threads: number;
  comments: number;
  recordings: number;
}

/** Everyone who commented or recorded, the most active first, then by name. */
export function reviewersOf(threads: readonly FeedbackThreadView[], recordings: readonly FeedbackRecordingView[]): Reviewer[] {
  const people = new Map<string, Reviewer>();
  const person = (oid: string, name: string): Reviewer => {
    const found = people.get(oid) ?? { oid, name, threads: 0, comments: 0, recordings: 0 };
    people.set(oid, found);
    return found;
  };
  for (const thread of threads) {
    person(thread.author.oid, thread.author.name).threads += 1;
    for (const comment of thread.comments) {
      person(comment.author.oid, comment.author.name).comments += 1;
    }
  }
  for (const recording of recordings) {
    person(recording.author.oid, recording.author.name).recordings += 1;
  }
  const activity = (reviewer: Reviewer): number => reviewer.comments + reviewer.recordings;
  return [...people.values()].sort((a, b) => activity(b) - activity(a) || byCodePoint(a.name, b.name) || byCodePoint(a.oid, b.oid));
}

export type Activity =
  | { kind: "thread"; at: string; who: string; threadId: string; pagePath: string; text: string }
  | { kind: "reply"; at: string; who: string; threadId: string; pagePath: string; text: string }
  | { kind: "resolved"; at: string; who: string; threadId: string; pagePath: string }
  | { kind: "recording"; at: string; who: string; recordingId: string; durationMs: number | null; status: FeedbackRecordingStatus };

/** What happened on the project, newest first, at most `limit` of it. */
export function recentActivity(threads: readonly FeedbackThreadView[], recordings: readonly FeedbackRecordingView[], limit = 10): Activity[] {
  const items: Activity[] = [];
  for (const thread of threads) {
    const [first, ...replies] = thread.comments;
    const base = { threadId: thread.id, pagePath: thread.pagePath };
    items.push({ kind: "thread", at: thread.createdAt, who: thread.author.name, text: first?.body ?? "", ...base });
    for (const reply of replies) {
      items.push({ kind: "reply", at: reply.createdAt, who: reply.author.name, text: reply.body, ...base });
    }
    if (thread.status === "resolved" && thread.resolvedAt !== null && thread.resolvedBy !== null) {
      items.push({ kind: "resolved", at: thread.resolvedAt, who: thread.resolvedBy.name, ...base });
    }
  }
  for (const recording of recordings) {
    items.push({
      kind: "recording",
      at: recording.startedAt,
      who: recording.author.name,
      recordingId: recording.id,
      durationMs: recording.durationMs,
      status: recording.status
    });
  }
  return items.sort((a, b) => byCodePoint(b.at, a.at)).slice(0, limit);
}

/** When anything last happened on the project, or when it was last changed. */
export function lastActivity(updatedAt: string, threads: readonly FeedbackThreadView[], recordings: readonly FeedbackRecordingView[]): string {
  const [latest] = recentActivity(threads, recordings, 1);
  return latest !== undefined && latest.at > updatedAt ? latest.at : updatedAt;
}

/**
 * One reviewer's threads and recordings in the order they made them. A thread they replied to counts, at their first
 * reply, as well as one they raised.
 */
export type ReviewerItem = { kind: "thread"; at: string; thread: FeedbackThreadView } | { kind: "recording"; at: string; recording: FeedbackRecordingView };

export function reviewerTimeline(oid: string, threads: readonly FeedbackThreadView[], recordings: readonly FeedbackRecordingView[]): ReviewerItem[] {
  const items: ReviewerItem[] = [];
  for (const thread of threads) {
    const theirs = thread.comments.find((comment) => comment.author.oid === oid);
    if (thread.author.oid === oid || theirs !== undefined) {
      items.push({ kind: "thread", at: thread.author.oid === oid ? thread.createdAt : (theirs as { createdAt: string }).createdAt, thread });
    }
  }
  for (const recording of recordings) {
    if (recording.author.oid === oid) {
      items.push({ kind: "recording", at: recording.startedAt, recording });
    }
  }
  return items.sort((a, b) => byCodePoint(a.at, b.at));
}

/** A duration as people say it: "45s", "3m 05s", "1h 02m". */
export function durationText(ms: number | null): string {
  if (ms === null) {
    return "still recording";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
