import { canManageUploadsOnDisk, canRemoveUploadFromDisk, type UploadState } from "../access/rules.ts";
import { clientSupports } from "../agents/client-features.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { MAX_DELETED_PER_FRAME, type PodFile, readAcknowledged, readReportedFiles, type UploadsDisk, uploadsDisk } from "./upload-report.ts";
import { UNTITLED } from "./views.ts";

/**
 * The copies of a person's attachments on their assistant's own volume: what the pod says is there, and the
 * deletions they have asked for.
 *
 * The hub's part rows are a 3-hour window and are swept whether a pod fetched them or not. The pod's copies under
 * `/workspace/uploads/<conversation-id>/` are kept until their conversation is deleted, so that is what accumulates
 * and what someone means by their files taking up space. **The hub cannot see it**: every call between the two is
 * pod to hub. So the pod reports, and a deletion is a request the pod reads off its sessions stream and carries out.
 *
 * Nothing here infers the disk from the hub's own rows. It could not honestly: a row records that a file was once
 * fetched, not that the pod still has it, and the sweep marks a `fetched` row `expired` for reasons of its own.
 */

/** What the settings' Files section is given: the disk as of the pod's last report, and the files it named. */
export interface UploadsOnDisk {
  disk: UploadsDisk;
  /** Largest first, as the pod sent them. Only files the hub still has a row for; see `readReportedFiles`. */
  files: PodFile[];
  /** How many the pod says it holds, which is more than it names when it holds more than `MAX_REPORTED_FILES`. */
  filesTotal: number;
  /** Deletions asked for and not yet confirmed by a report, counted across every file including unlisted ones. */
  deleting: number;
}

/** The report as the route's schema has already checked its figures. The lists are read leniently from here. */
export interface UploadsReportBody {
  uploads_bytes: number;
  volume_used_bytes: number;
  volume_total_bytes: number;
  files_total: number;
  files: unknown[];
  deleted: unknown[];
}

/**
 * Replaces the virtual agent's report, and ends every deletion request the pod says it has carried out.
 *
 * **Only `deleted` ends a request.** Absence from `files` means nothing: that list is the largest
 * `MAX_REPORTED_FILES`, so a file outside it is unnamed while sitting on the volume, and a report that named none at
 * all would otherwise mark every outstanding request done — leaving the owner told a file was deleted, the hub's own
 * bytes gone, and the pod's copy still there. The pod leaves out of `deleted` anything whose removal failed, so such
 * a request stays outstanding and is sent again on its next connect.
 *
 * It **notifies nobody**. A report is read by the owner's own page, which the action they took revalidates; nothing
 * streams it to a browser, and the pod that reported is the pod that already knows. A NOTIFY here would be a frame
 * for whatever is still pending, and a file the pod cannot delete would then loop between the two with no backoff
 * and nothing giving up — a retry on its next stream connect is the right cadence for that.
 */
export async function reportUploadsOnDisk(prisma: PrismaClient, virtualAgentId: string, report: UploadsReportBody, now: Date = new Date()): Promise<void> {
  const files = readReportedFiles(report.files);
  const acknowledged = readAcknowledged(report.deleted);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.virtualAgent.updateMany({
      where: { id: virtualAgentId },
      data: {
        uploadsBytes: BigInt(report.uploads_bytes),
        volumeUsedBytes: BigInt(report.volume_used_bytes),
        volumeTotalBytes: BigInt(report.volume_total_bytes),
        uploadsFiles: files,
        uploadsFilesTotal: report.files_total,
        uploadsReportedAt: now,
        updatedAt: now
      }
    });
    if (updated.count === 0 || acknowledged.length === 0) {
      return;
    }
    // Scoped to this pod's own conversations, so a launch token can only ever end requests of the assistant it is for.
    await tx.assistantUpload.updateMany({
      where: { conversation: { virtualAgentId }, podDeleteRequestedAt: { not: null }, podDeletedAt: null, id: { in: acknowledged } },
      data: { podDeletedAt: now, updatedAt: now }
    });
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredFile {
  upload_id: string;
  bytes: number;
}

/** The stored `uploads_files` column, read as defensively as it was written. */
function storedFiles(value: unknown): StoredFile[] {
  return readReportedFiles(value);
}

/**
 * What the viewer's assistant holds, for the settings dialog.
 *
 * The figures are the pod's and are always dated; `uploadsDisk` decides which of the "we have not heard" states to
 * say instead when there are none. `reports` comes from the pod's *own* session — the virtual agent's current agent,
 * which is the supervisor's registration — because the supervisor is what reports and what acts on a deletion, not a
 * conversation's session.
 */
export async function uploadsOnDisk(prisma: PrismaClient, viewerOid: string, virtualAgentId: string): Promise<UploadsOnDisk | undefined> {
  const agent = await prisma.virtualAgent.findUnique({
    where: { id: virtualAgentId },
    select: {
      ownerOid: true,
      status: true,
      uploadsBytes: true,
      volumeUsedBytes: true,
      volumeTotalBytes: true,
      uploadsFiles: true,
      uploadsFilesTotal: true,
      uploadsReportedAt: true,
      agent: { select: { clientFeatures: true } }
    }
  });
  if (agent === null || !canManageUploadsOnDisk(viewerOid, agent.ownerOid)) {
    return undefined;
  }
  const reported = storedFiles(agent.uploadsFiles);
  const disk = uploadsDisk({
    uploadsBytes: agent.uploadsBytes,
    volumeUsedBytes: agent.volumeUsedBytes,
    volumeTotalBytes: agent.volumeTotalBytes,
    uploadsReportedAt: agent.uploadsReportedAt,
    running: agent.status === "running",
    reports: clientSupports(agent.agent?.clientFeatures, "files")
  });
  const rows =
    reported.length === 0
      ? []
      : await prisma.assistantUpload.findMany({
          where: { id: { in: reported.map((file) => file.upload_id) }, ownerOid: viewerOid },
          select: { id: true, fileName: true, conversationId: true, podDeleteRequestedAt: true, podDeletedAt: true, conversation: { select: { title: true } } }
        });
  const named = new Map(rows.map((row) => [row.id, row]));
  const files = reported.flatMap<PodFile>((file) => {
    const row = named.get(file.upload_id);
    return row === undefined
      ? []
      : [
          {
            uploadId: row.id,
            name: row.fileName,
            bytes: file.bytes,
            conversationId: row.conversationId,
            conversationTitle: row.conversation.title ?? UNTITLED,
            deleting: row.podDeleteRequestedAt !== null && row.podDeletedAt === null
          }
        ];
  });
  return {
    disk,
    files,
    // The pod's own count, not the length of what it named: at exactly `MAX_REPORTED_FILES` nothing was cut, and
    // claiming a shortened list there would be a sentence about files that are all already on the screen.
    filesTotal: Math.max(agent.uploadsFilesTotal ?? reported.length, reported.length),
    deleting: await prisma.assistantUpload.count({
      where: { conversation: { virtualAgentId }, ownerOid: viewerOid, podDeleteRequestedAt: { not: null }, podDeletedAt: null }
    })
  };
}

/** Why a deletion was not asked for. The pod's client is the one refusal a person can do something about. */
export type RemoveOutcome = "requested" | "no_such_upload" | "unsupported_client";

/**
 * What was asked for: the outcome, and how many files it covered. The count is what a confirmation may claim, and is
 * of the rows the rules admitted rather than of the ids the caller named, which are not always the same number.
 */
export interface RemoveResult {
  outcome: RemoveOutcome;
  count: number;
}

/**
 * Asks for the pod's copies of `uploadIds` to go, and drops the hub's own part rows for them in the same breath.
 *
 * The hub's bytes go **now** because the person asked for the file to be deleted and that is the copy the hub can
 * reach. The upload is marked `expired`, which is the state that already means "the hub holds no bytes", so the
 * thread's chip stops offering a download exactly as it does when the sweep reaches the file. The row itself stays,
 * so the thread goes on saying a file was attached.
 *
 * Refused outright for a pod whose client never claimed `files`: it would ignore the frame in silence, and the hub
 * would have thrown its own bytes away to promise a deletion that never happens. The UI gates on the same claim, so
 * this is the second line of that defence rather than the one a person normally meets.
 */
export async function requestUploadRemoval(
  prisma: PrismaClient,
  viewerOid: string,
  virtualAgentId: string,
  uploadIds: readonly string[],
  now: Date = new Date()
): Promise<RemoveResult> {
  const refused: RemoveResult = { outcome: "no_such_upload", count: 0 };
  const ids = [...new Set(uploadIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) {
    return refused;
  }
  const agent = await prisma.virtualAgent.findUnique({
    where: { id: virtualAgentId },
    select: { ownerOid: true, agent: { select: { clientFeatures: true } } }
  });
  if (agent === null || !canManageUploadsOnDisk(viewerOid, agent.ownerOid)) {
    return refused;
  }
  if (!clientSupports(agent.agent?.clientFeatures, "files")) {
    return { outcome: "unsupported_client", count: 0 };
  }
  // One read for the whole set, since "delete everything" names as many as a report does, and constrained to this
  // assistant's own conversations — an upload of this person's on another of their virtual agents is not something
  // this pod could delete. `canRemoveUploadFromDisk` still decides each row, so the rule is not the query's shape.
  const rows = await prisma.assistantUpload.findMany({
    where: { id: { in: ids }, conversation: { virtualAgentId } },
    select: { id: true, conversationId: true, ownerOid: true, messageId: true, state: true }
  });
  const allowed = rows
    .filter((row) =>
      canRemoveUploadFromDisk(viewerOid, {
        conversationId: row.conversationId,
        ownerOid: row.ownerOid,
        messageId: row.messageId === null ? null : row.messageId.toString(),
        state: row.state as UploadState
      })
    )
    .map((row) => row.id);
  if (allowed.length === 0) {
    return refused;
  }
  await prisma.$transaction(async (tx) => {
    await tx.assistantUploadPart.deleteMany({ where: { uploadId: { in: allowed } } });
    await tx.assistantUpload.updateMany({
      where: { id: { in: allowed } },
      // `podDeletedAt` is cleared as well, so asking again for a file the pod reported back — which is how a pod
      // that failed its deletion shows up — is a fresh request rather than one already counted as done.
      data: { state: "expired", podDeleteRequestedAt: now, podDeletedAt: null, updatedAt: now }
    });
    await notify(tx, { type: "assistant_uploads", virtual_agent_id: virtualAgentId, owner_oid: viewerOid });
  });
  return { outcome: "requested", count: allowed.length };
}

/** Every upload of the viewer's that the pod's last report named, for "delete everything". */
export async function reportedUploadIds(db: Database, viewerOid: string, virtualAgentId: string): Promise<string[]> {
  const agent = await db.virtualAgent.findUnique({ where: { id: virtualAgentId }, select: { ownerOid: true, uploadsFiles: true } });
  if (agent === null || !canManageUploadsOnDisk(viewerOid, agent.ownerOid)) {
    return [];
  }
  return storedFiles(agent.uploadsFiles).map((file) => file.upload_id);
}

/** One conversation's outstanding deletion request, as a `delete_uploads` frame carries it. */
export interface UploadDeletion {
  conversation_id: string;
  upload_ids: string[];
}

/**
 * The deletions this assistant's pod has still to carry out, oldest conversation first.
 *
 * Read on every connect and on every `resync`, which is the difference from an `interrupt`: a file somebody asked to
 * delete should still go if the pod was restarting when they asked, and deleting a file that is already gone is a
 * deletion that has happened. Bounded per conversation by `MAX_DELETED_PER_FRAME`; what is left over is sent on the
 * next connect, once the report has cleared the ones that went.
 */
export async function pendingUploadDeletions(db: Database, virtualAgentId: string): Promise<UploadDeletion[]> {
  const rows = await db.assistantUpload.findMany({
    where: { conversation: { virtualAgentId }, podDeleteRequestedAt: { not: null }, podDeletedAt: null },
    select: { id: true, conversationId: true },
    orderBy: [{ conversationId: "asc" }, { createdAt: "asc" }]
  });
  const byConversation = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byConversation.get(row.conversationId) ?? [];
    if (ids.length < MAX_DELETED_PER_FRAME) {
      ids.push(row.id);
    }
    byConversation.set(row.conversationId, ids);
  }
  return [...byConversation].map(([conversation_id, upload_ids]) => ({ conversation_id, upload_ids }));
}
