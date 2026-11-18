import { randomUUID } from "node:crypto";
import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce } from "./conversation-row.ts";
import { lockConversation } from "./deck-store.ts";
import { jiraIssueUrl } from "./jira.ts";
import { parseVideoPath, STALE_UPLOAD_MS, type VideoBegin, type VideoChapter, videoPath, videoPrefix } from "./video.ts";
import type { VideoBlobs } from "./video-blob.ts";

/**
 * A conversation's journey video. The session asks to publish one (`beginVideo`, which records an `uploading` row and
 * names the blob), puts the bytes to Blob Storage itself, and says it has finished (`finishVideo`, which the route
 * calls once it has seen the blob at the size declared): that makes the row `ready` and the conversation's video the
 * one it has, and the older ready rows go. Deleting a conversation deletes its rows with it; its blobs are deleted by
 * `deleteVideoBlobs` straight after, and by the sweep for any that call missed. See "Journey videos" in
 * docs/agent-api.md.
 */

/** How many unfinished uploads one conversation may have at a time. */
export const MAX_OPEN_UPLOADS = 3;

export const VIDEO_SELECT = { videoName: true, videoVersion: true, videoUpdatedAt: true } as const;

/** What a page carries about the conversation's video; the panel reads the rest itself. */
export interface VideoSummary {
  name: string;
  version: number;
  updatedAt: string;
}

/** From the conversation's video columns (`VIDEO_SELECT`); `null` for a conversation with no video. */
export function videoSummary(row: { videoName: string | null; videoVersion: number; videoUpdatedAt: Date | null }): VideoSummary | null {
  if (row.videoVersion === 0 || row.videoName === null || row.videoUpdatedAt === null) {
    return null;
  }
  return { name: row.videoName, version: row.videoVersion, updatedAt: row.videoUpdatedAt.toISOString() };
}

/** The ready video, without the URLs a route signs for it. */
export interface VideoView {
  video_id: string;
  name: string;
  bytes: number;
  has_captions: boolean;
  chapters: VideoChapter[];
  coverage: string;
  coverage_summary: string | null;
  content_mismatches: string;
  jira_key: string | null;
  posted: { key: string; url: string; at: string } | null;
  finished_at: string;
}

interface Row {
  videoId: string;
  name: string;
  bytes: bigint;
  captions: string | null;
  chapters: unknown;
  coverage: string;
  coverageSummary: string | null;
  contentMismatches: string;
  jiraKey: string | null;
  postedKey: string | null;
  postedAt: Date | null;
  finishedAt: Date | null;
}

function chaptersOf(value: unknown): VideoChapter[] {
  return Array.isArray(value) ? (value as VideoChapter[]) : [];
}

function viewOf(row: Row): VideoView {
  return {
    video_id: row.videoId,
    name: row.name,
    bytes: Number(row.bytes),
    has_captions: row.captions !== null,
    chapters: chaptersOf(row.chapters),
    coverage: row.coverage,
    coverage_summary: row.coverageSummary,
    content_mismatches: row.contentMismatches,
    jira_key: row.jiraKey,
    posted: row.postedKey === null || row.postedAt === null ? null : { key: row.postedKey, url: jiraIssueUrl(row.postedKey), at: row.postedAt.toISOString() },
    finished_at: (row.finishedAt ?? new Date(0)).toISOString()
  };
}

/** The conversation's ready video, or `null` while it has none. */
export async function readyVideo(db: Database, conversationId: string): Promise<VideoView | null> {
  const row = await db.assistantVideo.findFirst({ where: { conversationId, status: "ready" }, orderBy: { finishedAt: "desc" } });
  return row === null ? null : viewOf(row);
}

/** The ready video's captions, or `null` when it has none or there is no video. */
export async function readyCaptions(db: Database, conversationId: string): Promise<string | null> {
  const row = await db.assistantVideo.findFirst({
    where: { conversationId, status: "ready" },
    orderBy: { finishedAt: "desc" },
    select: { captions: true }
  });
  return row?.captions ?? null;
}

async function conversationOf(db: Database, conversationId: string) {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: { id: true, virtualAgentId: true, ownerOid: true } });
  if (row === null) {
    throw new HttpError(404, "no such conversation");
  }
  return row;
}

/** Records an upload that is about to begin and answers the id it was given. At most `MAX_OPEN_UPLOADS` are open at once. */
export async function beginVideo(
  prisma: PrismaClient,
  { conversationId, body, now = new Date() }: { conversationId: string; body: VideoBegin; now?: Date }
): Promise<string> {
  return await prisma.$transaction(async (tx) => {
    await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const open = await tx.assistantVideo.count({
      where: { conversationId, status: "uploading", createdAt: { gt: new Date(now.getTime() - STALE_UPLOAD_MS) } }
    });
    if (open >= MAX_OPEN_UPLOADS) {
      throw new HttpError(429, `the conversation has ${MAX_OPEN_UPLOADS} uploads still open: finish or wait for them before publishing another`);
    }
    const videoId = randomUUID();
    await tx.assistantVideo.create({
      data: {
        videoId,
        conversationId,
        status: "uploading",
        name: body.name,
        bytes: BigInt(body.bytes),
        captions: body.captions ?? null,
        chapters: body.chapters,
        coverage: body.coverage,
        coverageSummary: body.coverage_summary ?? null,
        contentMismatches: body.content_mismatches,
        jiraKey: body.jira_key ?? null,
        createdAt: now
      }
    });
    return videoId;
  });
}

/** The size an upload declared, for its route to check the blob against; `undefined` when the conversation has no such upload. */
export async function uploadOf(db: Database, conversationId: string, videoId: string): Promise<{ bytes: number; name: string } | undefined> {
  const row = await db.assistantVideo.findFirst({ where: { videoId, conversationId }, select: { bytes: true, name: true } });
  return row === null ? undefined : { bytes: Number(row.bytes), name: row.name };
}

/**
 * Makes an upload the conversation's video, which the route has checked is in Blob Storage at its declared size. Answers
 * the ids of the ready videos it replaced, whose blobs the caller deletes. Finishing one that is already ready is
 * answered the same, with nothing replaced, so a retry after a lost response is harmless. Announced.
 */
export async function finishVideo(
  prisma: PrismaClient,
  { conversationId, videoId, etag, now = new Date() }: { conversationId: string; videoId: string; etag: string; now?: Date }
): Promise<{ replaced: string[] }> {
  return await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const row = await tx.assistantVideo.findFirst({ where: { videoId, conversationId }, select: { status: true, name: true } });
    if (row === null) {
      throw new HttpError(404, "that upload is not one of this conversation's");
    }
    if (row.status === "ready") {
      return { replaced: [] };
    }
    const older = await tx.assistantVideo.findMany({ where: { conversationId, status: "ready" }, select: { videoId: true } });
    await tx.assistantVideo.deleteMany({ where: { conversationId, status: "ready" } });
    const { count } = await tx.assistantVideo.updateMany({
      where: { videoId, conversationId, status: "uploading" },
      data: { status: "ready", finishedAt: now, etag }
    });
    if (count === 0) {
      throw new HttpError(404, "that upload is not one of this conversation's");
    }
    await tx.$executeRaw`
      UPDATE assistant_conversation
         SET video_version = video_version + 1, video_name = ${row.name}, video_updated_at = ${now},
             first_content_at = COALESCE(first_content_at, ${now}), updated_at = ${now}
       WHERE id = ${conversationId}::uuid
    `;
    await announce(tx, conversation);
    return { replaced: older.map((video) => video.videoId) };
  });
}

/**
 * Whether the conversation's ready video is still the blob that was checked when its upload finished. The upload URL can
 * write the blob until it expires, so a read URL is handed out only for a blob whose ETag and size are the recorded ones.
 */
export async function videoIntact(db: Database, blobs: VideoBlobs, conversationId: string, videoId: string): Promise<boolean> {
  const row = await db.assistantVideo.findFirst({ where: { videoId, conversationId, status: "ready" }, select: { etag: true, bytes: true } });
  if (row === null || row.etag === null) {
    return false;
  }
  const stat = await blobs.statOf(videoPath(conversationId, videoId));
  return stat !== undefined && stat.etag === row.etag && stat.size === Number(row.bytes);
}

/** Records that the conversation's ready video was attached to `issueKey`, for the panel to show. Announced. */
export async function recordPosted(
  prisma: PrismaClient,
  { conversationId, videoId, issueKey, now = new Date() }: { conversationId: string; videoId: string; issueKey: string; now?: Date }
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    const { count } = await tx.assistantVideo.updateMany({ where: { videoId, conversationId, status: "ready" }, data: { postedKey: issueKey, postedAt: now } });
    if (count === 0) {
      throw new HttpError(404, "that video is not the conversation's");
    }
    await tx.$executeRaw`UPDATE assistant_conversation SET video_updated_at = ${now} WHERE id = ${conversationId}::uuid`;
    await announce(tx, conversation);
  });
}

/** Whether a ready video of the conversation has this id, which a pod job's `precheck` asks. */
export async function hasReadyVideo(db: Database, conversationId: string, videoId: string): Promise<boolean> {
  return (await db.assistantVideo.count({ where: { videoId, conversationId, status: "ready" } })) > 0;
}

/**
 * Deletes every blob a conversation has, after the conversation is gone or the videos are. A failure is logged and left
 * to the sweep, which finds blobs no row names.
 */
export async function deleteVideoBlobs(blobs: VideoBlobs | undefined, conversationId: string): Promise<void> {
  if (blobs === undefined) {
    return;
  }
  try {
    await blobs.deletePrefix(videoPrefix(conversationId));
  } catch (error) {
    console.warn(`could not delete the journey videos of conversation ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Deletes the blobs of videos a finish replaced; the same fallback. */
export async function deleteReplacedBlobs(blobs: VideoBlobs | undefined, conversationId: string, videoIds: readonly string[]): Promise<void> {
  if (blobs === undefined || videoIds.length === 0) {
    return;
  }
  try {
    const failed = await blobs.deleteBlobs(videoIds.map((id) => videoPath(conversationId, id)));
    if (failed.length > 0) {
      console.warn(`could not delete ${failed.length} replaced journey videos of conversation ${conversationId}`);
    }
  } catch (error) {
    console.warn(`could not delete the replaced journey videos of conversation ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** "videosweep". Distinct from every other sweep's lock and the migration's. */
const VIDEO_SWEEP_LOCK_KEY = 0x76696465_6f737765n;
const VIDEO_SWEEP_INTERVAL_MS = 10 * 60_000;
const VIDEO_SWEEP_TIMEOUT_MS = 5 * 60_000;
/** How many blob names are checked against the rows in one query. */
const NAME_BATCH = 500;

export interface VideoSweepResult {
  /** Uploads begun and never finished, deleted. */
  stale: number;
  /** Blobs no row names, deleted. */
  orphans: number;
}

/**
 * Deletes the uploads that were never finished, row and blob, and every blob no row names: those of a conversation
 * deleted (which a delete of its blobs may have missed), of a video a finish replaced, and of an upload whose row is
 * gone. A row is written before any URL for its blob is signed, so a blob without one is never an upload in progress.
 * A name that is not one this hub made is left alone. One pod sweeps per tick, under an advisory lock, and `undefined`
 * means another held it.
 */
export async function sweepVideos(prisma: PrismaClient, blobs: VideoBlobs, now: Date = new Date()): Promise<VideoSweepResult | undefined> {
  return await prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${VIDEO_SWEEP_LOCK_KEY}) AS locked`;
      if (lock?.locked !== true) {
        return undefined;
      }
      // The rows go first, in one statement that only takes `uploading` ones: a finish that wins the row makes it ready and
      // this leaves it, and one that loses finds no row. Either way no ready row is left without its blob. A blob whose
      // delete fails below has no row and is found by the unnamed-blob step.
      const stale = await prisma.$queryRaw<{ video_id: string; conversation_id: string }[]>`
        DELETE FROM assistant_video
         WHERE video_id IN (
                 SELECT video_id FROM assistant_video
                  WHERE status = 'uploading' AND created_at < ${new Date(now.getTime() - STALE_UPLOAD_MS)}
                  LIMIT ${NAME_BATCH}::int
                  FOR UPDATE SKIP LOCKED)
           AND status = 'uploading'
        RETURNING video_id::text AS video_id, conversation_id::text AS conversation_id
      `;
      await blobs.deleteBlobs(stale.map((row) => videoPath(row.conversation_id, row.video_id)));

      const named = (await blobs.listNames("")).flatMap((name) => {
        const parsed = parseVideoPath(name);
        return parsed === undefined ? [] : [{ name, ...parsed }];
      });
      let orphans = 0;
      for (let at = 0; at < named.length; at += NAME_BATCH) {
        const chunk = named.slice(at, at + NAME_BATCH);
        const held = new Set(
          (
            await prisma.assistantVideo.findMany({
              where: { videoId: { in: chunk.map((entry) => entry.videoId) } },
              select: { videoId: true, conversationId: true }
            })
          ).map((row) => `${row.conversationId}/${row.videoId}`)
        );
        const unnamed = chunk.filter((entry) => !held.has(`${entry.conversationId}/${entry.videoId}`)).map((entry) => entry.name);
        orphans += unnamed.length - (await blobs.deleteBlobs(unnamed)).length;
      }
      return { stale: stale.length, orphans };
    },
    { timeout: VIDEO_SWEEP_TIMEOUT_MS, maxWait: 10_000 }
  );
}

export interface VideoSweeper {
  stop: () => Promise<void>;
}

/** Runs `sweepVideos` on an interval, with the timer unreferenced as the other sweeps' are. */
export function startVideoSweep(prisma: PrismaClient, blobs: VideoBlobs, intervalMs: number = VIDEO_SWEEP_INTERVAL_MS): VideoSweeper {
  let running = false;
  let tick: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    tick = sweepVideos(prisma, blobs)
      .then((result) => {
        if (result !== undefined && result.stale + result.orphans > 0) {
          console.info(`video sweep: ${result.stale} unfinished uploads and ${result.orphans} unnamed blobs deleted`);
        }
      })
      .catch((error: unknown) => {
        console.warn(`the video sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await tick;
    }
  };
}
