import { canRecordFeedback, canSeeFeedbackRecording } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/ids.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, Prisma, PrismaClient } from "../store/prisma.ts";
import { type SegmentKind, segmentPath } from "./blob.ts";
import { FEEDBACK_RATE_WINDOW_MS, MAX_RECORDINGS_PER_WINDOW, MAX_SEGMENTS_PER_WINDOW } from "./limits.ts";
import type { FeedbackUploadInput } from "./schemas.ts";
import { type FeedbackScope, type ResolvedScope, resolveScope, scopeWhere, writableScope } from "./scope.ts";
import { lockFeedbackLink, underLimit } from "./store.ts";
import type { FeedbackAuthor } from "./thread-store.ts";

/**
 * A reviewer's recordings: started and stopped through their link, uploaded by the browser straight to Blob Storage in
 * numbered segments, each segment's row written when its upload is asked for. The team plays every recording; a
 * reviewer only their own (`canSeeFeedbackRecording`).
 */

export type FeedbackRecordingStatus = "recording" | "ready" | "failed";

export interface FeedbackSegmentView {
  id: string;
  kind: SegmentKind;
  seq: number;
  pagePath: string | null;
  blobPath: string;
  offsetMs: number;
  bytes: number;
}

export interface FeedbackRecordingView {
  id: string;
  projectId: string;
  linkId: string;
  author: FeedbackAuthor;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: FeedbackRecordingStatus;
  prototypeVersion: string | null;
}

/** A thread made while the recording ran, as a marker on the player's timeline. */
export interface FeedbackRecordingMarker {
  threadId: string;
  offsetMs: number;
  pagePath: string;
}

export interface FeedbackRecordingDetail extends FeedbackRecordingView {
  /** Audio first, then replay, each in order. */
  segments: FeedbackSegmentView[];
  markers: FeedbackRecordingMarker[];
}

const RECORDING_COLUMNS = {
  id: true,
  projectId: true,
  linkId: true,
  author: { select: { oid: true, name: true } },
  startedAt: true,
  endedAt: true,
  durationMs: true,
  status: true,
  prototypeVersion: true
} as const satisfies Prisma.FeedbackRecordingSelect;

type RecordingRow = Prisma.FeedbackRecordingGetPayload<{ select: typeof RECORDING_COLUMNS }>;

const NOT_FOUND = "that recording is not there";

/** Most recordings one read answers, newest first. */
export const MAX_RECORDINGS_LISTED = 200;

function recordingView(row: RecordingRow): FeedbackRecordingView {
  return {
    ...row,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    status: row.status as FeedbackRecordingStatus
  };
}

/** The recording when the scope reaches it and the viewer may see it, or the 404 any other is reported as. */
async function recordingIn(db: Database, viewerOid: string, scope: ResolvedScope, recordingId: string): Promise<RecordingRow> {
  const row = isUuid(recordingId)
    ? await db.feedbackRecording.findFirst({ where: { id: recordingId, ...scopeWhere(scope) }, select: RECORDING_COLUMNS })
    : null;
  if (row === null || !canSeeFeedbackRecording(scope.access, viewerOid, row.author.oid)) {
    throw new HttpError(404, NOT_FOUND);
  }
  return row;
}

/** The viewer's own recording through the link, still running, or why it cannot be added to. */
async function runningRecording(db: Database, viewerOid: string, scope: ResolvedScope, recordingId: string): Promise<RecordingRow> {
  const row = await recordingIn(db, viewerOid, scope, recordingId);
  if (!canRecordFeedback(scope.access, viewerOid, row.author.oid)) {
    throw new HttpError(404, NOT_FOUND);
  }
  if (row.status !== "recording") {
    throw new HttpError(409, "that recording has stopped");
  }
  return row;
}

/** Starts a recording by the viewer through the link. */
export async function startRecording(prisma: PrismaClient, viewerOid: string, token: string, now: Date = new Date()): Promise<FeedbackRecordingView> {
  const scope = await writableScope(prisma, viewerOid, { token });
  const linkId = scope.linkId as string;
  const id = await prisma.$transaction(async (tx) => {
    await lockFeedbackLink(tx, linkId);
    await underLimit(
      tx.feedbackRecording.count({ where: { linkId, authorOid: viewerOid, startedAt: { gte: new Date(now.getTime() - FEEDBACK_RATE_WINDOW_MS) } } }),
      MAX_RECORDINGS_PER_WINDOW
    );
    const row = await tx.feedbackRecording.create({
      data: { projectId: scope.projectId, linkId, authorOid: viewerOid, startedAt: now, prototypeVersion: scope.prototypeVersion },
      select: { id: true }
    });
    await notify(tx, { type: "feedback", project_id: scope.projectId, link_id: linkId });
    return row.id;
  });
  return recordingView(await recordingIn(prisma, viewerOid, scope, id));
}

export interface RequestedSegment {
  segmentId: string;
  /** Where the browser is to put the segment; the route hands back a write SAS for it. */
  blobPath: string;
}

/**
 * Records one segment of the viewer's running recording and answers where to upload it. Asking again for the same
 * kind and number, as a browser does after a failed upload, records it again at the same path. Not announced: a
 * segment changes nothing anyone's page shows until the recording stops.
 */
export async function requestSegment(
  prisma: PrismaClient,
  viewerOid: string,
  token: string,
  recordingId: string,
  input: FeedbackUploadInput,
  now: Date = new Date()
): Promise<RequestedSegment> {
  const scope = await writableScope(prisma, viewerOid, { token });
  const linkId = scope.linkId as string;
  await runningRecording(prisma, viewerOid, scope, recordingId);
  const blobPath = segmentPath(scope.projectId, recordingId, input.kind, input.seq);
  return await prisma.$transaction(async (tx) => {
    await lockFeedbackLink(tx, linkId);
    await underLimit(
      tx.feedbackRecordingSegment.count({
        where: { recording: { linkId, authorOid: viewerOid }, createdAt: { gte: new Date(now.getTime() - FEEDBACK_RATE_WINDOW_MS) } }
      }),
      MAX_SEGMENTS_PER_WINDOW
    );
    const fields = { pagePath: input.pagePath, offsetMs: input.offsetMs, bytes: input.bytes, blobPath };
    const row = await tx.feedbackRecordingSegment.upsert({
      where: { recordingId_kind_seq: { recordingId, kind: input.kind, seq: input.seq } },
      create: { recordingId, kind: input.kind, seq: input.seq, ...fields, createdAt: now },
      update: fields,
      select: { id: true }
    });
    return { segmentId: row.id, blobPath };
  });
}

/** Stops the viewer's running recording, which makes it playable. */
export async function completeRecording(
  prisma: PrismaClient,
  viewerOid: string,
  token: string,
  recordingId: string,
  { durationMs }: { durationMs: number },
  now: Date = new Date()
): Promise<FeedbackRecordingView> {
  const scope = await writableScope(prisma, viewerOid, { token });
  const row = await runningRecording(prisma, viewerOid, scope, recordingId);
  await prisma.$transaction(async (tx) => {
    await tx.feedbackRecording.update({ where: { id: recordingId }, data: { status: "ready", endedAt: now, durationMs } });
    await notify(tx, { type: "feedback", project_id: row.projectId, link_id: row.linkId });
  });
  return recordingView(await recordingIn(prisma, viewerOid, scope, recordingId));
}

export interface FeedbackRecordingFilter {
  /** One link of the project; ignored through a token, which is held to its own link. */
  linkId?: string;
  authorOid?: string;
}

/** The recordings the viewer may see through the scope, newest first. */
export async function listRecordings(
  db: Database,
  viewerOid: string,
  scope: FeedbackScope,
  filter: FeedbackRecordingFilter = {}
): Promise<FeedbackRecordingView[]> {
  const resolved = await resolveScope(db, viewerOid, scope);
  const linkId = resolved.linkId ?? filter.linkId;
  if (linkId !== undefined && !isUuid(linkId)) {
    return [];
  }
  // A reviewer's own and nobody else's, as `canSeeFeedbackRecording` decides for one; the filter below re-applies it.
  const authorOid = resolved.access === "team" ? filter.authorOid : viewerOid;
  const rows = await db.feedbackRecording.findMany({
    where: { projectId: resolved.projectId, ...(linkId === undefined ? {} : { linkId }), ...(authorOid === undefined ? {} : { authorOid }) },
    select: RECORDING_COLUMNS,
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    take: MAX_RECORDINGS_LISTED
  });
  return rows.filter((row) => canSeeFeedbackRecording(resolved.access, viewerOid, row.author.oid)).map(recordingView);
}

/** One recording with its segments and the threads made during it, for the player. */
export async function getRecording(db: Database, viewerOid: string, scope: FeedbackScope, recordingId: string): Promise<FeedbackRecordingDetail> {
  const resolved = await resolveScope(db, viewerOid, scope);
  const row = await recordingIn(db, viewerOid, resolved, recordingId);
  const [segments, threads] = await Promise.all([
    db.feedbackRecordingSegment.findMany({
      where: { recordingId },
      select: { id: true, kind: true, seq: true, pagePath: true, blobPath: true, offsetMs: true, bytes: true },
      orderBy: [{ kind: "asc" }, { seq: "asc" }]
    }),
    db.feedbackThread.findMany({
      where: { recordingId, offsetMs: { not: null } },
      select: { id: true, offsetMs: true, pagePath: true },
      orderBy: [{ offsetMs: "asc" }, { id: "asc" }]
    })
  ]);
  return {
    ...recordingView(row),
    segments: segments.map((segment) => ({ ...segment, kind: segment.kind as SegmentKind })),
    markers: threads.map((thread) => ({ threadId: thread.id, offsetMs: thread.offsetMs as number, pagePath: thread.pagePath }))
  };
}

/**
 * The pages each recording's replay visited, in the order it first reached them, for recordings `listRecordings`
 * already let the viewer see.
 */
export async function recordingPages(db: Database, recordingIds: readonly string[]): Promise<Map<string, string[]>> {
  const pages = new Map<string, string[]>(recordingIds.map((id) => [id, []]));
  if (recordingIds.length === 0) {
    return pages;
  }
  const rows = await db.feedbackRecordingSegment.findMany({
    where: { recordingId: { in: [...recordingIds] }, kind: "replay", pagePath: { not: null } },
    select: { recordingId: true, pagePath: true },
    orderBy: [{ recordingId: "asc" }, { seq: "asc" }]
  });
  for (const row of rows) {
    const seen = pages.get(row.recordingId);
    if (seen !== undefined && row.pagePath !== null && !seen.includes(row.pagePath)) {
      seen.push(row.pagePath);
    }
  }
  return pages;
}
