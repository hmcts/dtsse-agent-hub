import { randomUUID } from "node:crypto";
import { canManageVirtualAgent, canUseDocmosisLibrary } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/ids.ts";
import { podReady, podState } from "../agents/pod-ready.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { findAssistantWithClaims } from "./assistant-store.ts";
import {
  DOCMOSIS_LIBRARY,
  DOCMOSIS_LIBRARY_ID,
  forcedTooSoon,
  INDEX_REFRESH_PENDING_MS,
  type IndexAnswer,
  type IndexEntry,
  isCommitSha,
  isEntriesKey,
  isLibraryPath,
  keptResetAt,
  type LibraryPodGate,
  type LibraryRow,
  type LibraryStatus,
  libraryStatus,
  MAX_INDEX_BYTES,
  refreshDecision,
  storedEntriesBytes
} from "./docmosis-library.ts";

/**
 * The template library's index as the hub keeps it: one row per person and library, which is also the one check of it
 * in flight. Opening the library asks the person's pod for a check when one is due, the sessions stream sends it, and
 * the pod's answer replaces the index, confirms it or records why it could not. See "Docmosis template library" in
 * docs/agent-api.md.
 */

/** Every column but the entries, which are only read by the one route that serves them. */
const ROW_COLUMNS = {
  ownerOid: true,
  commitSha: true,
  entryCount: true,
  checkedAt: true,
  refreshId: true,
  refreshRequestedAt: true,
  forcedAt: true,
  dropped: true,
  entriesKey: true,
  error: true,
  detail: true,
  ssoUrl: true,
  resetAt: true
} as const;

const key = (ownerOid: string) => ({ ownerOid_libraryId: { ownerOid, libraryId: DOCMOSIS_LIBRARY_ID } });

const pendingSince = (now: Date): Date => new Date(now.getTime() - INDEX_REFRESH_PENDING_MS);

async function viewersAssistant(prisma: PrismaClient, viewerOid: string) {
  const found = await findAssistantWithClaims(prisma, viewerOid);
  if (found === undefined || !canManageVirtualAgent(viewerOid, found.assistant)) {
    throw new HttpError(404, "you have no assistant to read the template library with yet");
  }
  return found;
}

/**
 * The library's status for the viewer as it stands, asking nothing of their pod and starting none: what a tab reads
 * when it is told the status changed, or when a check it saw pending has had its two minutes.
 */
export async function readLibrary(prisma: PrismaClient, viewerOid: string, now: Date = new Date()): Promise<LibraryStatus> {
  const found = await viewersAssistant(prisma, viewerOid);
  const held = await prisma.assistantDocmosisLibrary.findUnique({ where: key(viewerOid), select: ROW_COLUMNS });
  return libraryStatus(held, podState(found, "docmosis-library"), now);
}

/**
 * The library's status for the viewer, asking their pod for a check when one is due (`refreshDecision`). Only a pod
 * that can answer is asked; a stopped one is started only while there is no index yet, since an index that is a few
 * minutes old serves the browser as well as a pod booting for a minute would. The row is locked only when a check may
 * be needed, and the decision made again under the lock, so two tabs opening it at once ask once and the second joins
 * the first's check. A forced check within 30 seconds of the last forced one is `429`.
 */
export async function openLibrary(prisma: PrismaClient, viewerOid: string, { force }: { force: boolean }, now: Date = new Date()): Promise<LibraryStatus> {
  const found = await viewersAssistant(prisma, viewerOid);
  const held = await prisma.assistantDocmosisLibrary.findUnique({ where: key(viewerOid), select: ROW_COLUMNS });
  const hasIndex = held !== null && held.commitSha !== null;
  const gate: LibraryPodGate =
    found.assistant.desired === "stopped" && hasIndex ? "stopped" : await podReady(prisma, viewerOid, found, "docmosis-library", now);
  if (gate !== "ok" || (held !== null && refreshDecision(held, now, force) === "none")) {
    return libraryStatus(held, gate, now);
  }
  const assistantId = found.assistant.id;
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO assistant_docmosis_library (owner_oid, library_id) VALUES (${viewerOid}, ${DOCMOSIS_LIBRARY_ID})
      ON CONFLICT (owner_oid, library_id) DO NOTHING
    `;
    await tx.$queryRaw`SELECT 1 FROM assistant_docmosis_library WHERE owner_oid = ${viewerOid} AND library_id = ${DOCMOSIS_LIBRARY_ID} FOR UPDATE`;
    const locked: LibraryRow = await tx.assistantDocmosisLibrary.findUniqueOrThrow({ where: key(viewerOid), select: ROW_COLUMNS });
    if (force && forcedTooSoon(locked, now)) {
      throw new HttpError(429, "the template library was checked a moment ago; wait a few seconds and try again");
    }
    if (refreshDecision(locked, now, force) !== "ask") {
      return locked;
    }
    const requestId = randomUUID();
    const asked = await tx.assistantDocmosisLibrary.update({
      where: key(viewerOid),
      data: { refreshId: requestId, refreshRequestedAt: now, refreshAgentId: assistantId, ...(force ? { forcedAt: now } : {}), updatedAt: now },
      select: ROW_COLUMNS
    });
    await notify(tx, { type: "assistant_docmosis_index", request_id: requestId, virtual_agent_id: assistantId, owner_oid: viewerOid });
    return asked;
  });
  return libraryStatus(row, gate, now);
}

/** What the sessions stream sends the pod for one check. */
export interface DocmosisIndexFrame {
  request_id: string;
  owner: string;
  repo: string;
  ref: string;
  path: string;
  /** The commit and ETag the hub holds, so an unchanged library is a `304`; null when it holds none. */
  commit: string | null;
  etag: string | null;
}

/** The check last sent to this virtual agent for its owner's index, when it is still waited for; `undefined` otherwise. */
export async function pendingIndexFrame(
  db: Database,
  virtualAgent: { id: string; ownerOid: string },
  requestId: string,
  now: Date = new Date()
): Promise<DocmosisIndexFrame | undefined> {
  if (!isUuid(requestId)) {
    return undefined;
  }
  const row = await db.assistantDocmosisLibrary.findFirst({
    where: { refreshId: requestId, refreshAgentId: virtualAgent.id, libraryId: DOCMOSIS_LIBRARY_ID, refreshRequestedAt: { gt: pendingSince(now) } },
    select: { ownerOid: true, commitSha: true, etag: true }
  });
  if (row === null || !canUseDocmosisLibrary(virtualAgent.ownerOid, row)) {
    return undefined;
  }
  return { request_id: requestId, ...DOCMOSIS_LIBRARY, commit: row.commitSha, etag: row.etag };
}

function checkEntries(entries: readonly IndexEntry[]): void {
  const bad = entries.findIndex(([path]) => !isLibraryPath(path));
  if (bad !== -1) {
    throw new HttpError(400, `entries.${bad}: is not a .docx under ${DOCMOSIS_LIBRARY.path}/`);
  }
  if (storedEntriesBytes(entries) > MAX_INDEX_BYTES) {
    throw new HttpError(413, `an index is at most ${MAX_INDEX_BYTES} bytes`);
  }
}

/**
 * The pod's answer, kept only for the check the hub last sent to that virtual agent for its owner and only while it is
 * still waited for, so a late, repeated or stray answer changes nothing. Every path is checked before anything is written,
 * so a bad index is refused with the one held kept. A failure is recorded beside the last good entries rather than in
 * place of them.
 */
export async function answerIndex(
  prisma: PrismaClient,
  virtualAgent: { id: string; ownerOid: string },
  requestId: string,
  answer: IndexAnswer,
  now: Date = new Date()
): Promise<void> {
  if ("entries" in answer) {
    checkEntries(answer.entries);
  }
  if (!isUuid(requestId)) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ owner_oid: string; commit_sha: string | null; etag: string | null }[]>`
      SELECT owner_oid, commit_sha, etag FROM assistant_docmosis_library
       WHERE refresh_id = ${requestId}::uuid AND refresh_agent_id = ${virtualAgent.id}::uuid AND library_id = ${DOCMOSIS_LIBRARY_ID} AND refresh_requested_at > ${pendingSince(now)}
       FOR UPDATE
    `;
    if (row === undefined || !canUseDocmosisLibrary(virtualAgent.ownerOid, { ownerOid: row.owner_oid })) {
      return;
    }
    const cleared = { refreshId: null, refreshAgentId: null, checkedAt: now, updatedAt: now, error: null, detail: null, ssoUrl: null, resetAt: null };
    let data: Record<string, unknown>;
    if ("entries" in answer) {
      data = {
        ...cleared,
        commitSha: answer.commit,
        etag: answer.etag,
        entries: answer.entries,
        entryCount: answer.entries.length,
        dropped: answer.dropped ?? 0
      };
    } else if ("unchanged" in answer) {
      if (row.commit_sha === null) {
        throw new HttpError(400, "there is no index to keep; answer with the entries");
      }
      data = { ...cleared, etag: answer.etag === undefined ? row.etag : answer.etag };
    } else {
      data = {
        ...cleared,
        error: answer.error,
        detail: answer.detail ?? null,
        ssoUrl: answer.sso_url ?? null,
        resetAt: keptResetAt(answer.reset_at, now)
      };
    }
    await tx.assistantDocmosisLibrary.update({ where: key(row.owner_oid), data });
    await notify(tx, { type: "assistant_docmosis_library", owner_oid: row.owner_oid });
  });
}

/**
 * The entries of the viewer's index at `commit`; `undefined` unless that is the index they hold now and `entriesKey`
 * is their own, so an address cached for another person on the same browser is never theirs.
 */
export async function readLibraryEntries(
  db: Database,
  viewerOid: string,
  commit: string,
  entriesKey: string
): Promise<{ commit: string; entries: IndexEntry[] } | undefined> {
  if (!isCommitSha(commit) || !isEntriesKey(entriesKey)) {
    return undefined;
  }
  const row = await db.assistantDocmosisLibrary.findUnique({
    where: key(viewerOid),
    select: { ownerOid: true, commitSha: true, entriesKey: true, entries: true }
  });
  if (row === null || row.commitSha !== commit || row.entriesKey !== entriesKey.toLowerCase() || !canUseDocmosisLibrary(viewerOid, row)) {
    return undefined;
  }
  return { commit, entries: row.entries as unknown as IndexEntry[] };
}
