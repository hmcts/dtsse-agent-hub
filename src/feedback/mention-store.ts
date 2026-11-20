import { type FeedbackLinkAccess, feedbackLinkAccess, feedbackProjectAccess } from "../access/rules.ts";
import { isUuid } from "../agents/ids.ts";
import type { Database, Prisma } from "../store/prisma.ts";
import type { FeedbackAnchor } from "./schemas.ts";
import type { FeedbackAuthor, FeedbackThreadStatus } from "./thread-store.ts";

/**
 * The comments that named a person with `@`, as their Mentions list shows them, and how many they have not seen yet,
 * which the sidebar shows beside it. A mention is listed while the person can still read its comment: to the project's
 * team (`feedbackProjectAccess`) until the project is archived, whether or not its link is still live, and to a
 * reviewer named on a link (`feedbackLinkAccess`) only while that link is. It opens where they can read it: the
 * project's page for its team, the link's review page for a reviewer.
 */

/** Most mentions the list shows, newest first, which is more than a person has to catch up on in one sitting. */
export const MAX_MENTIONS_LISTED = 50;

/** Most unseen mentions counted for the badge, which shows anything over as "99+". */
export const MAX_MENTIONS_COUNTED = 100;

export interface FeedbackMentionView {
  commentId: string;
  threadId: string;
  projectId: string;
  projectName: string;
  pagePath: string;
  pageTitle: string | null;
  anchor: FeedbackAnchor;
  threadStatus: FeedbackThreadStatus;
  author: FeedbackAuthor;
  body: string;
  /** Everyone the comment names, so the list can pick them out of its text. */
  named: FeedbackAuthor[];
  createdAt: string;
  /** Whether the person has seen it in their Mentions list before. */
  seen: boolean;
  /** Where the person reads the comment and replies. */
  href: string;
}

const AUTHOR = { select: { oid: true, name: true } } as const;

const ACCESS_COLUMNS = {
  link: { select: { token: true, revokedAt: true } },
  project: { select: { id: true, name: true, ownerOid: true, archivedAt: true, members: { select: { memberOid: true } } } }
} as const;

const MENTION_COLUMNS = {
  commentId: true,
  seenAt: true,
  comment: {
    select: {
      body: true,
      createdAt: true,
      author: AUTHOR,
      mentions: { select: { person: AUTHOR }, orderBy: { personOid: "asc" } },
      thread: { select: { id: true, pagePath: true, pageTitle: true, anchor: true, status: true, ...ACCESS_COLUMNS } }
    }
  }
} as const satisfies Prisma.FeedbackMentionSelect;

type ThreadAccessRow = Prisma.FeedbackThreadGetPayload<{ select: typeof ACCESS_COLUMNS }>;

function accessOf(personOid: string, thread: ThreadAccessRow): FeedbackLinkAccess {
  const memberOids = thread.project.members.map((member) => member.memberOid);
  if (feedbackProjectAccess(personOid, thread.project, memberOids) !== "none") {
    return thread.project.archivedAt === null ? "team" : "none";
  }
  return feedbackLinkAccess(personOid, { revokedAt: thread.link.revokedAt, project: thread.project }, memberOids);
}

/** Where a mention opens: the comment on its project's page for the team, the page it is on for a reviewer. */
export function mentionHref(
  access: Exclude<FeedbackLinkAccess, "none">,
  mention: { projectId: string; threadId: string; token: string; pagePath: string }
): string {
  if (access === "team") {
    return `/assistant/feedback/${mention.projectId}?${new URLSearchParams({ tab: "comments", thread: mention.threadId })}`;
  }
  return `/review/${mention.token}?${new URLSearchParams({ path: mention.pagePath })}`;
}

const LIVE_PROJECT = { comment: { thread: { project: { archivedAt: null } } } } as const satisfies Prisma.FeedbackMentionWhereInput;

/** The comments that named `personOid`, newest first, that they can still open. */
export async function listMentions(db: Database, personOid: string, limit = MAX_MENTIONS_LISTED): Promise<FeedbackMentionView[]> {
  const rows = await db.feedbackMention.findMany({
    where: { personOid, ...LIVE_PROJECT },
    select: MENTION_COLUMNS,
    orderBy: [{ comment: { createdAt: "desc" } }, { commentId: "desc" }],
    take: limit
  });
  const views: FeedbackMentionView[] = [];
  for (const row of rows) {
    const { thread } = row.comment;
    const access = accessOf(personOid, thread);
    if (access === "none") {
      continue;
    }
    views.push({
      commentId: row.commentId,
      threadId: thread.id,
      projectId: thread.project.id,
      projectName: thread.project.name,
      pagePath: thread.pagePath,
      pageTitle: thread.pageTitle,
      anchor: thread.anchor as FeedbackAnchor,
      threadStatus: thread.status as FeedbackThreadStatus,
      author: row.comment.author,
      body: row.comment.body,
      named: row.comment.mentions.map((mention) => mention.person),
      createdAt: row.comment.createdAt.toISOString(),
      seen: row.seenAt !== null,
      href: mentionHref(access, { projectId: thread.project.id, threadId: thread.id, token: thread.link.token, pagePath: thread.pagePath })
    });
  }
  return views;
}

/** How many of the mentions `listMentions` would show `personOid` they have not seen, up to `MAX_MENTIONS_COUNTED`. */
export async function unseenMentionCount(db: Database, personOid: string): Promise<number> {
  const rows = await db.feedbackMention.findMany({
    where: { personOid, seenAt: null, ...LIVE_PROJECT },
    select: { comment: { select: { thread: { select: ACCESS_COLUMNS } } } },
    take: MAX_MENTIONS_COUNTED
  });
  return rows.filter((row) => accessOf(personOid, row.comment.thread) !== "none").length;
}

/** How many of a person's newest mentions are read to tell whether any is still theirs to open. */
const MENTIONS_PROBED = 20;

/**
 * What the sidebar shows of `personOid`'s mentions: how many they have not seen, or null when they have none they
 * could open, seen or not, which hides Mentions altogether rather than offering an empty list.
 */
export async function mentionsBadge(db: Database, personOid: string): Promise<number | null> {
  const unseen = await unseenMentionCount(db, personOid);
  if (unseen > 0) {
    return unseen;
  }
  const rows = await db.feedbackMention.findMany({
    where: { personOid, ...LIVE_PROJECT },
    select: { comment: { select: { thread: { select: ACCESS_COLUMNS } } } },
    orderBy: [{ comment: { createdAt: "desc" } }, { commentId: "desc" }],
    take: MENTIONS_PROBED
  });
  return rows.some((row) => accessOf(personOid, row.comment.thread) !== "none") ? 0 : null;
}

/**
 * Marks the mentions of `personOid` on `commentIds` seen, those the list showed them, so one that arrives after the
 * list was read stays counted. A mention seen before keeps when it was first seen. Answers how many were marked.
 */
export async function markMentionsSeen(db: Database, personOid: string, commentIds: readonly string[], now: Date = new Date()): Promise<number> {
  const ids = [...new Set(commentIds.filter(isUuid))];
  if (ids.length === 0) {
    return 0;
  }
  const { count } = await db.feedbackMention.updateMany({ where: { personOid, commentId: { in: ids }, seenAt: null }, data: { seenAt: now } });
  return count;
}
