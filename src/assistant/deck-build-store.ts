import { canChangeDeck } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { podReady } from "../agents/pod-ready.ts";
import { isUuid } from "../agents/store.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { findAssistantWithClaims } from "./assistant-store.ts";
import type { DeckOutline } from "./deck.ts";
import {
  buildStatus,
  DECK_BUILD_TIMEOUT_MS,
  DECK_BUILDS_KEPT,
  type DeckBuildRequest,
  type DeckBuildView,
  heldBuildSince,
  SLIDES_NOT_TURNED_ON,
  SLIDES_PLUGIN
} from "./deck-build.ts";
import { readDeckVersionEntry } from "./deck-history-store.ts";
import { type DeckAsset, lockConversation } from "./deck-store.ts";
import { accessToConversation } from "./shares.ts";

/**
 * A build of one deck version's .pptx, asked for by the conversation's owner and made by its pod: recorded here, sent
 * to the pod on its sessions stream, answered with the bytes or why there are none, and read back by the slides
 * panel. See "Deck builds" in docs/agent-api.md.
 *
 * A row is pending until the pod answers, or until `DECK_BUILD_TIMEOUT_MS` has passed, after which it reads as timed
 * out whatever it still says and the pod's late answer is ignored. The sweep writes that down and deletes builds older
 * than `DECK_BUILD_KEEP_MS` (`heldBuildSince`); nothing relies on it having run, since every read checks the clock itself.
 */

const pendingSince = (now: Date): Date => new Date(now.getTime() - DECK_BUILD_TIMEOUT_MS);

/** Writes down the conversation's builds that have run out of time, so the partial unique index lets another start. */
async function expire(db: Database, conversationId: string | null, now: Date): Promise<number> {
  return await db.assistantDeckBuild
    .updateMany({
      where: { ...(conversationId === null ? {} : { conversationId }), status: "pending", createdAt: { lt: pendingSince(now) } },
      data: { status: "timeout", finishedAt: now }
    })
    .then((result) => result.count);
}

/**
 * Asks the conversation's pod to build `version`, or joins the build of it already running. Only the owner may ask
 * (`canChangeDeck`): a reader is refused, and anyone else finds nothing, as the reads do. Nothing is recorded when the
 * .pptx is already there, when the pod cannot be asked now, when its client cannot build, or when the conversation is a
 * local session's, which has no pod.
 */
export async function requestDeckBuild(
  prisma: PrismaClient,
  viewerOid: string,
  conversationId: string,
  version: number,
  now: Date = new Date()
): Promise<DeckBuildRequest> {
  const allowed = await accessToConversation(prisma, viewerOid, conversationId);
  if (allowed === undefined) {
    throw new HttpError(404, "that chat has no slides you can read");
  }
  if (!canChangeDeck(allowed.access)) {
    throw new HttpError(403, "only the person whose chat this is can prepare its slides");
  }
  const kept = await readDeckVersionEntry(prisma, conversationId, version, now);
  if (kept === undefined) {
    throw new HttpError(404, "that version of the slides is not there");
  }
  if (kept.pptx) {
    return { status: "ready" };
  }
  const running = await prisma.assistantDeckBuild.findFirst({
    where: { conversationId, version, status: "pending", createdAt: { gte: pendingSince(now) } },
    select: { id: true }
  });
  if (running !== null) {
    return { status: "pending", job_id: running.id };
  }
  const { conversation } = allowed;
  // A local session's conversation has no pod to build on, and never will.
  if (conversation.virtualAgentId === null) {
    return { status: "no_pod" };
  }
  const found = await findAssistantWithClaims(prisma, viewerOid);
  // The chat's assistant has been replaced by another, which has none of its sessions.
  if (found === undefined || found.assistant.id !== conversation.virtualAgentId) {
    return { status: "assistant_gone" };
  }
  const { assistant } = found;
  if (!assistant.plugins.includes(SLIDES_PLUGIN)) {
    throw new HttpError(409, SLIDES_NOT_TURNED_ON);
  }
  const ready = await podReady(prisma, viewerOid, found, "deck-build", now);
  if (ready !== "ok") {
    return { status: ready };
  }
  const id = await prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    await expire(tx, conversationId, now);
    const joined = await tx.assistantDeckBuild.findFirst({ where: { conversationId, version, status: "pending" }, select: { id: true } });
    if (joined !== null) {
      return joined.id;
    }
    const row = await tx.assistantDeckBuild.create({ data: { conversationId, version, createdAt: now }, select: { id: true } });
    await notify(tx, { type: "assistant_deck_build", job_id: row.id, virtual_agent_id: assistant.id, owner_oid: viewerOid });
    return row.id;
  });
  return { status: "pending", job_id: id };
}

/** One of the owner's builds as it stands now; anybody else's, or one swept, is not found. */
export async function readDeckBuild(
  db: Database,
  viewerOid: string,
  conversationId: string,
  jobId: string,
  now: Date = new Date()
): Promise<DeckBuildView | undefined> {
  if (!isUuid(jobId) || !isUuid(conversationId)) {
    return undefined;
  }
  const allowed = await accessToConversation(db, viewerOid, conversationId);
  if (allowed === undefined || !canChangeDeck(allowed.access)) {
    return undefined;
  }
  const row = await db.assistantDeckBuild.findUnique({
    where: { id: jobId },
    select: { id: true, conversationId: true, version: true, status: true, error: true, createdAt: true }
  });
  if (row === null || row.conversationId !== conversationId || row.createdAt < heldBuildSince(now)) {
    return undefined;
  }
  const status = buildStatus(row, now);
  return { status, job_id: row.id, version: row.version, ...(status === "failed" && row.error !== null ? { error: row.error } : {}) };
}

/** What the sessions stream sends the pod for one build. */
export interface DeckBuildFrame {
  job_id: string;
  conversation_id: string;
  version: number;
}

/** A build in one of this virtual agent's conversations, still waiting for its answer; `undefined` otherwise. */
async function pendingBuild(db: Database, virtualAgentId: string, jobId: string, now: Date) {
  if (!isUuid(jobId)) {
    return undefined;
  }
  const row = await db.assistantDeckBuild.findUnique({
    where: { id: jobId },
    select: { id: true, conversationId: true, version: true, status: true, createdAt: true, conversation: { select: { virtualAgentId: true } } }
  });
  if (row === null || row.conversation.virtualAgentId !== virtualAgentId || buildStatus(row, now) !== "pending") {
    return undefined;
  }
  return row;
}

export async function pendingDeckBuild(db: Database, virtualAgentId: string, jobId: string, now: Date = new Date()): Promise<DeckBuildFrame | undefined> {
  const row = await pendingBuild(db, virtualAgentId, jobId, now);
  return row === undefined ? undefined : { job_id: row.id, conversation_id: row.conversationId, version: row.version };
}

/** The version a pending build is of, outline and all, for the pod to build. */
export async function podDeckBuild(
  db: Database,
  virtualAgentId: string,
  jobId: string,
  now: Date = new Date()
): Promise<(DeckBuildFrame & { outline: DeckOutline }) | undefined> {
  const row = await pendingBuild(db, virtualAgentId, jobId, now);
  if (row === undefined) {
    return undefined;
  }
  const version = await db.assistantDeckVersion.findUnique({
    where: { conversationId_version: { conversationId: row.conversationId, version: row.version } },
    select: { outline: true }
  });
  return version === null
    ? undefined
    : { job_id: row.id, conversation_id: row.conversationId, version: row.version, outline: version.outline as unknown as DeckOutline };
}

/**
 * One picture a pending build's outline names; nothing else of the deck's. The build, its outline and the picture are
 * read in one query, as a pod fetches every picture of a build in turn.
 */
export async function podDeckBuildAsset(
  db: Database,
  virtualAgentId: string,
  jobId: string,
  sha256: string,
  now: Date = new Date()
): Promise<DeckAsset | undefined> {
  if (!isUuid(jobId)) {
    return undefined;
  }
  const [asset] = await db.$queryRaw<DeckAsset[]>`
    SELECT a.mime, a.bytes
      FROM assistant_deck_build b
      JOIN assistant_conversation c ON c.id = b.conversation_id
      JOIN assistant_deck_version v ON v.conversation_id = b.conversation_id AND v.version = b.version
      JOIN assistant_deck_asset a ON a.conversation_id = b.conversation_id AND a.sha256 = ${sha256}
     WHERE b.id = ${jobId}::uuid AND c.virtual_agent_id = ${virtualAgentId}::uuid
       AND b.status = 'pending' AND b.created_at > ${pendingSince(now)}
       AND jsonb_path_exists(v.outline, '$.slides[*].image.asset ? (@ == $ref)', jsonb_build_object('ref', 'sha256:' || a.sha256))
  `;
  return asset;
}

export type DeckBuildAnswer = { pptx: Uint8Array } | { error: string };

/**
 * The pod's answer, kept only for a build of one of its own conversations that is still pending, so a late or
 * repeated answer, or one for another assistant's build, changes nothing. Keeping it deletes the conversation's
 * finished builds beyond the newest `DECK_BUILDS_KEPT`.
 */
export async function answerDeckBuild(
  prisma: PrismaClient,
  virtualAgentId: string,
  jobId: string,
  answer: DeckBuildAnswer,
  now: Date = new Date()
): Promise<void> {
  const row = await pendingBuild(prisma, virtualAgentId, jobId, now);
  if (row === undefined) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    const data =
      "pptx" in answer ? { status: "done", pptx: Buffer.from(answer.pptx), finishedAt: now } : { status: "failed", error: answer.error, finishedAt: now };
    const { count } = await tx.assistantDeckBuild.updateMany({ where: { id: row.id, status: "pending", createdAt: { gte: pendingSince(now) } }, data });
    if (count === 0) {
      return;
    }
    await tx.$executeRaw`
      DELETE FROM assistant_deck_build
       WHERE conversation_id = ${row.conversationId}::uuid AND status <> 'pending'
         AND id NOT IN (
           SELECT id FROM assistant_deck_build
            WHERE conversation_id = ${row.conversationId}::uuid AND status <> 'pending'
            ORDER BY created_at DESC, id ASC
            LIMIT ${DECK_BUILDS_KEPT}::int
         )
    `;
  });
}

/** "deckbild". Distinct from every other sweep's lock. */
const DECK_BUILD_SWEEP_LOCK_KEY = 0x6465636b_62696c64n;
const DECK_BUILD_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Writes down the builds that ran out of time and deletes those older than `DECK_BUILD_KEEP_MS`, with their bytes.
 * The same transaction-scoped advisory lock as the other sweeps, so one pod sweeps per tick; `undefined` means another
 * pod held it.
 */
export async function sweepDeckBuilds(prisma: PrismaClient, now: Date = new Date()): Promise<{ timedOut: number; deleted: number } | undefined> {
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${DECK_BUILD_SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }
    const timedOut = await expire(tx, null, now);
    const { count: deleted } = await tx.assistantDeckBuild.deleteMany({ where: { createdAt: { lt: heldBuildSince(now) } } });
    return { timedOut, deleted };
  });
}

/** Runs `sweepDeckBuilds` on an interval, unreferenced, as the other sweeps are. */
export function startDeckBuildSweep(prisma: PrismaClient, intervalMs: number = DECK_BUILD_SWEEP_INTERVAL_MS): { stop: () => Promise<void> } {
  let tick: Promise<void> = Promise.resolve();
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    tick = sweepDeckBuilds(prisma)
      .then(() => undefined)
      .catch((error: unknown) => console.warn(`the deck build sweep failed: ${error instanceof Error ? error.message : String(error)}`))
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
