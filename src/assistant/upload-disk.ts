import { canManageUploadsOnDisk, canRemoveUploadFromDisk } from "../access/rules.ts";
import { clientSupports } from "../agents/client-features.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { MAX_DELETED_PER_FRAME, MAX_REPORTED_FILES, type PodFile, readReportedFiles, type UploadsDisk, uploadsDisk } from "./upload-report.ts";
import { findUpload } from "./upload-store.ts";
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
  /** The pod holds more than one report names, so the list is the largest `MAX_REPORTED_FILES` and says so. */
  truncated: boolean;
  /** Deletions asked for and not yet confirmed by a report, counted across every file including unlisted ones. */
  deleting: number;
}

/**
 * Replaces the virtual agent's report, and clears every deletion request the report does not name.
 *
 * That clearing is the whole handshake: a requested upload the pod no longer lists is one it has deleted, and one it
 * never had is a request there was never anything to carry out. Both end the same way, so nothing has to be
 * acknowledged and the `delete_uploads` frame stops being replayed without the pod saying anything about it.
 *
 * In one transaction with the NOTIFY, so a UI watching the section redraws on what was actually written.
 */
export async function reportUploadsOnDisk(prisma: PrismaClient, virtualAgentId: string, report: unknown, now: Date = new Date()): Promise<void> {
  const body = report as { uploads_bytes: number; volume_used_bytes: number; volume_total_bytes: number; files?: unknown };
  const files = readReportedFiles(body.files);
  await prisma.$transaction(async (tx) => {
    const agent = await tx.virtualAgent.findUnique({ where: { id: virtualAgentId }, select: { ownerOid: true } });
    if (agent === null) {
      return;
    }
    await tx.virtualAgent.update({
      where: { id: virtualAgentId },
      data: {
        uploadsBytes: BigInt(body.uploads_bytes),
        volumeUsedBytes: BigInt(body.volume_used_bytes),
        volumeTotalBytes: BigInt(body.volume_total_bytes),
        uploadsFiles: files,
        uploadsReportedAt: now,
        updatedAt: now
      }
    });
    await tx.assistantUpload.updateMany({
      where: {
        conversation: { virtualAgentId },
        podDeleteRequestedAt: { not: null },
        podDeletedAt: null,
        id: { notIn: files.map((file) => file.upload_id) }
      },
      data: { podDeletedAt: now, updatedAt: now }
    });
    await notify(tx, { type: "assistant_uploads", virtual_agent_id: virtualAgentId, owner_oid: agent.ownerOid });
  });
}

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
    truncated: reported.length >= MAX_REPORTED_FILES,
    deleting: await prisma.assistantUpload.count({
      where: { conversation: { virtualAgentId }, ownerOid: viewerOid, podDeleteRequestedAt: { not: null }, podDeletedAt: null }
    })
  };
}

/** Why a deletion was not asked for. The pod's client is the one refusal a person can do something about. */
export type RemoveOutcome = "requested" | "no_such_upload" | "unsupported_client";

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
): Promise<RemoveOutcome> {
  if (uploadIds.length === 0) {
    return "no_such_upload";
  }
  const agent = await prisma.virtualAgent.findUnique({
    where: { id: virtualAgentId },
    select: { ownerOid: true, agent: { select: { clientFeatures: true } } }
  });
  if (agent === null || !canManageUploadsOnDisk(viewerOid, agent.ownerOid)) {
    return "no_such_upload";
  }
  if (!clientSupports(agent.agent?.clientFeatures, "files")) {
    return "unsupported_client";
  }
  const allowed: string[] = [];
  for (const uploadId of uploadIds) {
    const upload = await findUpload(prisma, uploadId);
    if (upload !== undefined && canRemoveUploadFromDisk(viewerOid, upload)) {
      allowed.push(uploadId);
    }
  }
  if (allowed.length === 0) {
    return "no_such_upload";
  }
  await prisma.$transaction(async (tx) => {
    await tx.assistantUploadPart.deleteMany({ where: { uploadId: { in: allowed } } });
    await tx.assistantUpload.updateMany({
      where: { id: { in: allowed }, ownerOid: viewerOid },
      // `podDeletedAt` is cleared as well, so asking again for a file the pod reported back — which is how a pod
      // that failed its deletion shows up — is a fresh request rather than one already counted as done.
      data: { state: "expired", podDeleteRequestedAt: now, podDeletedAt: null, updatedAt: now }
    });
    await notify(tx, { type: "assistant_uploads", virtual_agent_id: virtualAgentId, owner_oid: viewerOid });
  });
  return "requested";
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
