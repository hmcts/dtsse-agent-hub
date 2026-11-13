import { randomUUID } from "node:crypto";
import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/ids.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, Prisma, PrismaClient } from "../store/prisma.ts";
import { snapshotPath } from "./blob.ts";
import { FEEDBACK_RATE_WINDOW_MS, MAX_COMMENTS_PER_WINDOW, MAX_THREADS_PER_WINDOW } from "./limits.ts";
import { mentionsIn } from "./mentions.ts";
import type { CreateFeedbackThreadInput, FeedbackAnchor, PatchFeedbackThreadInput } from "./schemas.ts";
import { type FeedbackScope, type ResolvedScope, resolveScope, scopeWhere, writableScope } from "./scope.ts";
import { lockFeedbackLink, mentionablePeople, underLimit } from "./store.ts";

/** Comment threads pinned to a prototype's pages, their comments and the people those name. */

export type FeedbackThreadStatus = "open" | "resolved" | "detached";

export interface FeedbackAuthor {
  oid: string;
  name: string;
}

export interface FeedbackCommentView {
  id: string;
  author: FeedbackAuthor;
  body: string;
  createdAt: string;
  /** The oids the comment names with `@`. */
  mentions: string[];
}

export interface FeedbackThreadView {
  id: string;
  projectId: string;
  linkId: string;
  pagePath: string;
  anchor: FeedbackAnchor;
  status: FeedbackThreadStatus;
  author: FeedbackAuthor;
  resolvedBy: FeedbackAuthor | null;
  resolvedAt: string | null;
  /** Where the page's snapshot is in the container, for a read SAS; null when none was taken. */
  snapshotBlob: string | null;
  recordingId: string | null;
  offsetMs: number | null;
  prototypeVersion: string | null;
  createdAt: string;
  updatedAt: string;
  comments: FeedbackCommentView[];
}

export interface FeedbackThreadFilter {
  /** One link of the project; ignored through a token, which is held to its own link. */
  linkId?: string;
  pagePath?: string;
  status?: FeedbackThreadStatus;
  authorOid?: string;
}

/** Most threads one read answers, oldest first, which a page of a prototype is far below. */
export const MAX_THREADS_LISTED = 500;

const AUTHOR = { select: { oid: true, name: true } } as const;

const THREAD_COLUMNS = {
  id: true,
  projectId: true,
  linkId: true,
  pagePath: true,
  anchor: true,
  status: true,
  author: AUTHOR,
  resolvedBy: AUTHOR,
  resolvedAt: true,
  snapshotBlob: true,
  recordingId: true,
  offsetMs: true,
  prototypeVersion: true,
  createdAt: true,
  updatedAt: true,
  comments: {
    select: { id: true, author: AUTHOR, body: true, createdAt: true, mentions: { select: { personOid: true }, orderBy: { personOid: "asc" } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  }
} as const satisfies Prisma.FeedbackThreadSelect;

type ThreadRow = Prisma.FeedbackThreadGetPayload<{ select: typeof THREAD_COLUMNS }>;
type CommentRow = ThreadRow["comments"][number];

function commentView(row: CommentRow): FeedbackCommentView {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    mentions: row.mentions.map((mention) => mention.personOid)
  };
}

function threadView(row: ThreadRow): FeedbackThreadView {
  return {
    ...row,
    anchor: row.anchor as FeedbackAnchor,
    status: row.status as FeedbackThreadStatus,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    comments: row.comments.map(commentView)
  };
}

/** The threads the scope reaches, each with its comments and their authors' names, oldest first. */
export async function listThreads(db: Database, viewerOid: string, scope: FeedbackScope, filter: FeedbackThreadFilter = {}): Promise<FeedbackThreadView[]> {
  const resolved = await resolveScope(db, viewerOid, scope);
  const where: Prisma.FeedbackThreadWhereInput = {
    ...scopeWhere(resolved),
    ...(resolved.linkId === null && filter.linkId !== undefined ? { linkId: filter.linkId } : {}),
    ...(filter.pagePath === undefined ? {} : { pagePath: filter.pagePath }),
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(filter.authorOid === undefined ? {} : { authorOid: filter.authorOid })
  };
  if (where.linkId !== undefined && !isUuid(where.linkId as string)) {
    return [];
  }
  const rows = await db.feedbackThread.findMany({ where, select: THREAD_COLUMNS, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: MAX_THREADS_LISTED });
  return rows.map(threadView);
}

/** One thread the scope reaches, or the 404 any other is reported as. */
export async function getThread(db: Database, viewerOid: string, scope: FeedbackScope, threadId: string): Promise<FeedbackThreadView> {
  const resolved = await resolveScope(db, viewerOid, scope);
  return threadView(await threadIn(db, resolved, threadId));
}

async function threadIn(db: Database, scope: ResolvedScope, threadId: string): Promise<ThreadRow> {
  const row = isUuid(threadId) ? await db.feedbackThread.findFirst({ where: { id: threadId, ...scopeWhere(scope) }, select: THREAD_COLUMNS }) : null;
  if (row === null) {
    throw new HttpError(404, "that thread is not there");
  }
  return row;
}

/**
 * The people a comment names, who must be among those `mentionablePeople` offers. Read before the link's lock is
 * taken, so every comment on the link does not queue behind the lookup, and not at all for a body with no `@`.
 */
async function namedIn(db: Database, scope: { projectId: string; linkId: string }, authorOid: string, body: string): Promise<string[]> {
  if (!body.includes("@")) {
    return [];
  }
  const people = await mentionablePeople(db, scope.projectId, scope.linkId);
  return mentionsIn(
    body,
    people.filter((person) => person.oid !== authorOid)
  );
}

/** Writes a comment and the people it names. */
async function writeComment(db: Database, threadId: string, authorOid: string, body: string, named: readonly string[], now: Date): Promise<string> {
  const comment = await db.feedbackComment.create({ data: { threadId, authorOid, body, createdAt: now }, select: { id: true } });
  if (named.length > 0) {
    await db.feedbackMention.createMany({ data: named.map((personOid) => ({ commentId: comment.id, personOid })) });
  }
  return comment.id;
}

export interface CreatedFeedbackThread {
  thread: FeedbackThreadView;
  /** Where to upload the page's snapshot, when one was asked for; the route hands back a write SAS for it. */
  snapshotPath: string | null;
}

/**
 * A new thread on the link's prototype, with its first comment and the people that names, in one transaction. A
 * thread made during a recording names it, which has to be the viewer's own on the same link.
 */
export async function createThread(
  prisma: PrismaClient,
  viewerOid: string,
  token: string,
  input: CreateFeedbackThreadInput,
  now: Date = new Date()
): Promise<CreatedFeedbackThread> {
  const scope = await writableScope(prisma, viewerOid, { token });
  const linkId = scope.linkId as string;
  const id = randomUUID();
  const snapshot = input.snapshot ? snapshotPath(scope.projectId, id) : null;
  const named = await namedIn(prisma, { projectId: scope.projectId, linkId }, viewerOid, input.body);
  await prisma.$transaction(async (tx) => {
    await lockFeedbackLink(tx, linkId);
    await underLimit(
      tx.feedbackThread.count({ where: { linkId, authorOid: viewerOid, createdAt: { gte: new Date(now.getTime() - FEEDBACK_RATE_WINDOW_MS) } } }),
      MAX_THREADS_PER_WINDOW
    );
    if (input.recordingId !== null) {
      const recording = await tx.feedbackRecording.count({ where: { id: input.recordingId, linkId, authorOid: viewerOid } });
      if (recording === 0) {
        throw new HttpError(400, "recording_id: that is not one of your recordings on this link");
      }
    }
    await tx.feedbackThread.create({
      data: {
        id,
        projectId: scope.projectId,
        linkId,
        authorOid: viewerOid,
        pagePath: input.pagePath,
        anchor: input.anchor,
        snapshotBlob: snapshot,
        recordingId: input.recordingId,
        offsetMs: input.offsetMs,
        prototypeVersion: scope.prototypeVersion,
        createdAt: now,
        updatedAt: now
      }
    });
    await writeComment(tx, id, viewerOid, input.body, named, now);
    await notify(tx, { type: "feedback", project_id: scope.projectId, link_id: linkId });
  });
  return { thread: threadView(await threadIn(prisma, scope, id)), snapshotPath: snapshot };
}

/** A reply on a thread the scope reaches, which moves the thread's `updated_at` on. */
export async function replyToThread(
  prisma: PrismaClient,
  viewerOid: string,
  scope: FeedbackScope,
  threadId: string,
  body: string,
  now: Date = new Date()
): Promise<FeedbackCommentView> {
  const resolved = await writableScope(prisma, viewerOid, scope);
  const thread = await threadIn(prisma, resolved, threadId);
  const named = await namedIn(prisma, { projectId: thread.projectId, linkId: thread.linkId }, viewerOid, body);
  const commentId = await prisma.$transaction(async (tx) => {
    await lockFeedbackLink(tx, thread.linkId);
    await underLimit(
      tx.feedbackComment.count({
        where: { authorOid: viewerOid, thread: { linkId: thread.linkId }, createdAt: { gte: new Date(now.getTime() - FEEDBACK_RATE_WINDOW_MS) } }
      }),
      MAX_COMMENTS_PER_WINDOW
    );
    const id = await writeComment(tx, threadId, viewerOid, body, named, now);
    await tx.feedbackThread.update({ where: { id: threadId }, data: { updatedAt: now } });
    await notify(tx, { type: "feedback", project_id: thread.projectId, link_id: thread.linkId });
    return id;
  });
  const row = await prisma.feedbackComment.findUniqueOrThrow({ where: { id: commentId }, select: THREAD_COLUMNS.comments.select });
  return commentView(row);
}

/**
 * Resolves, reopens or detaches a thread, or re-anchors it, which puts it back on the page as open. Anyone the scope
 * lets in may, reviewers included: they resolve what they raised.
 */
export async function patchThread(
  prisma: PrismaClient,
  viewerOid: string,
  scope: FeedbackScope,
  threadId: string,
  patch: PatchFeedbackThreadInput,
  now: Date = new Date()
): Promise<FeedbackThreadView> {
  const resolved = await writableScope(prisma, viewerOid, scope);
  const thread = await threadIn(prisma, resolved, threadId);
  const status: FeedbackThreadStatus = "status" in patch ? patch.status : "open";
  const data: Prisma.FeedbackThreadUncheckedUpdateInput = {
    status,
    updatedAt: now,
    ...(status === "resolved" ? { resolvedByOid: viewerOid, resolvedAt: now } : { resolvedByOid: null, resolvedAt: null }),
    ...("anchor" in patch ? { anchor: patch.anchor, ...(patch.pagePath === undefined ? {} : { pagePath: patch.pagePath }) } : {})
  };
  await prisma.$transaction(async (tx) => {
    await tx.feedbackThread.update({ where: { id: threadId }, data });
    await notify(tx, { type: "feedback", project_id: thread.projectId, link_id: thread.linkId });
  });
  return threadView(await threadIn(prisma, resolved, threadId));
}
