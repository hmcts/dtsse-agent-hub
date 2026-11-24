import { type FeedbackLinkAccess, feedbackLinkAccess, feedbackProjectAccess } from "../access/rules.ts";
import { isUuid } from "../agents/ids.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, Prisma, PrismaClient } from "../store/prisma.ts";
import type { FeedbackAnchor } from "./schemas.ts";
import type { FeedbackAuthor, FeedbackThreadStatus } from "./thread-store.ts";

/**
 * The comments that named a person with `@`, as their Mentions list shows them, and how many they have not seen yet,
 * which the sidebar shows beside it. A mention is listed while the person can still read its comment: to the project's
 * team (`feedbackProjectAccess`) until the project is archived, whether or not its link is still live, and to a
 * reviewer named on a link (`feedbackLinkAccess`) only while that link is. It opens where they can read it: the
 * project's page for its team, the link's review page for a reviewer.
 */

/**
 * Most mentions the list shows, newest first, which is more than a person has to catch up on in one sitting. The
 * sidebar counts the unseen among these same ones, so opening the list always clears its count.
 */
export const MAX_MENTIONS_LISTED = 50;

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

/**
 * The mentions of `personOid` that `accessOf` can let them open, as a query, so the newest of them are read whatever
 * number of others they can no longer open: a live project they are on the team of, or a live link. `accessOf` is
 * still asked of every row, being the rule.
 */
function openable(personOid: string): Prisma.FeedbackMentionWhereInput {
  return {
    personOid,
    comment: {
      thread: {
        project: { archivedAt: null },
        OR: [{ project: { ownerOid: personOid } }, { project: { members: { some: { memberOid: personOid } } } }, { link: { revokedAt: null } }]
      }
    }
  };
}

const NEWEST = [{ comment: { createdAt: "desc" } }, { commentId: "desc" }] as const satisfies Prisma.FeedbackMentionOrderByWithRelationInput[];

/** The comments that named `personOid`, newest first, that they can still open. */
export async function listMentions(db: Database, personOid: string): Promise<FeedbackMentionView[]> {
  const rows = await db.feedbackMention.findMany({
    where: openable(personOid),
    select: MENTION_COLUMNS,
    orderBy: NEWEST,
    take: MAX_MENTIONS_LISTED
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

/**
 * What the sidebar shows of `personOid`'s mentions: how many of those `listMentions` shows them they have not seen,
 * or null when it would show them none, which hides Mentions altogether rather than offering an empty list.
 */
export async function mentionsBadge(db: Database, personOid: string): Promise<number | null> {
  const rows = await db.feedbackMention.findMany({
    where: openable(personOid),
    select: { seenAt: true, comment: { select: { thread: { select: ACCESS_COLUMNS } } } },
    orderBy: NEWEST,
    take: MAX_MENTIONS_LISTED
  });
  const listed = rows.filter((row) => accessOf(personOid, row.comment.thread) !== "none");
  return listed.length === 0 ? null : listed.filter((row) => row.seenAt === null).length;
}

/**
 * Marks the mentions of `personOid` on `commentIds` seen, those the list showed them, so one that arrives after the
 * list was read stays counted. A mention seen before keeps when it was first seen. Answers how many were marked.
 */
export async function markMentionsSeen(prisma: PrismaClient, personOid: string, commentIds: readonly string[], now: Date = new Date()): Promise<number> {
  const ids = [...new Set(commentIds.filter(isUuid))];
  if (ids.length === 0) {
    return 0;
  }
  return await prisma.$transaction(async (tx) => {
    const { count } = await tx.feedbackMention.updateMany({ where: { personOid, commentId: { in: ids }, seenAt: null }, data: { seenAt: now } });
    // The person's other tabs count their mentions too.
    if (count > 0) {
      await notify(tx, { type: "feedback_mention", person_oids: [personOid] });
    }
    return count;
  });
}
