import { canAttachUpload, canSessionUseAttachment, canWriteUpload, type UploadRef, type UploadState } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import {
  DEFAULT_MEDIA_TYPE,
  describeBytes,
  fileNameOf,
  isMediaType,
  isUploadSize,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CONVERSATION_BYTES,
  MAX_UPLOAD_BYTES,
  PART_BYTES,
  partCount,
  partLength,
  storedNameOf,
  type UploadRefusal
} from "./uploads.ts";

/**
 * The files attached to Assistant messages: the metadata rows, and the parts the browser sends and the pod pulls.
 *
 * Postgres holds the bytes only between the two: the browser's last part makes an upload `stored`, the pod's fetched
 * report deletes every part row, and the sweep deletes the parts of anything nobody fetched. Nothing here ever holds
 * more than one part in memory, which is what keeps a 25 MB file off a 768 MB heap.
 */

/** What Prisma's `Bytes` resolves to: a view onto its own buffer, never a shared one. */
export type UploadBytes = Uint8Array<ArrayBuffer>;

export interface UploadRow extends UploadRef {
  id: string;
  fileName: string;
  storedName: string;
  mediaType: string;
  bytes: number;
}

/** An attachment as the thread shows it: the person's own file name, so the chip matches what they picked. */
export interface MessageAttachment {
  id: string;
  name: string;
  bytes: number;
  media_type: string;
}

/** An attachment as a `direct` frame carries it: `name` is the stored name, which is what the pod writes. */
export interface FrameAttachment {
  upload_id: string;
  name: string;
  bytes: number;
  media_type: string;
  part_bytes: number;
  parts: number;
}

const SELECT = {
  id: true,
  conversationId: true,
  ownerOid: true,
  messageId: true,
  fileName: true,
  storedName: true,
  mediaType: true,
  bytes: true,
  state: true
} as const;

function toRow(row: {
  id: string;
  conversationId: string;
  ownerOid: string;
  messageId: bigint | null;
  fileName: string;
  storedName: string;
  mediaType: string;
  bytes: bigint;
  state: string;
}): UploadRow {
  return {
    id: row.id,
    conversationId: row.conversationId,
    ownerOid: row.ownerOid,
    messageId: row.messageId === null ? null : row.messageId.toString(),
    fileName: row.fileName,
    storedName: row.storedName,
    mediaType: row.mediaType,
    bytes: Number(row.bytes),
    state: row.state as UploadState
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findUpload(db: Database, id: string): Promise<UploadRow | undefined> {
  if (!UUID.test(id)) {
    return undefined;
  }
  const row = await db.assistantUpload.findUnique({ where: { id }, select: SELECT });
  return row === null ? undefined : toRow(row);
}

export class UploadNotFound extends HttpError {
  constructor() {
    super(404, "no such upload", { reason: "no_such_upload" satisfies UploadRefusal });
  }
}

export interface NewUpload {
  conversationId: string;
  ownerOid: string;
  name: unknown;
  size: unknown;
  mediaType: unknown;
}

export interface CreatedUpload {
  uploadId: string;
  partBytes: number;
  parts: number;
}

/**
 * Starts an upload: a `pending` row, and the part size the browser is to cut the file into. The sanitised
 * `stored_name` is decided here and is the authoritative one — the pod re-sanitises it, but never invents it.
 *
 * The conversation's row is taken first, so the caps are read and acted on one starter at a time: at the default
 * isolation level two tabs would otherwise both read the same total and both find room for the last file. What a
 * conversation holds counts every upload still alive, fetched ones included: the pod's disk keeps them, and
 * `/workspace` filling up breaks its repository clones rather than just the next upload.
 */
export async function createUpload(prisma: PrismaClient, upload: NewUpload): Promise<CreatedUpload> {
  if (!isUploadSize(upload.size)) {
    throw new HttpError(400, `a file is 1 byte to ${describeBytes(MAX_UPLOAD_BYTES)}`, { reason: "file_too_big" satisfies UploadRefusal });
  }
  const size = upload.size;
  const mediaType = isMediaType(upload.mediaType) ? upload.mediaType.toLowerCase() : DEFAULT_MEDIA_TYPE;
  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM assistant_conversation WHERE id = ${upload.conversationId}::uuid FOR UPDATE`;
    const pending = await tx.assistantUpload.count({ where: { conversationId: upload.conversationId, messageId: null, state: { in: ["pending", "stored"] } } });
    if (pending >= MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new HttpError(409, `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files`, { reason: "too_many_files" satisfies UploadRefusal });
    }
    const [total] = await tx.$queryRaw<{ bytes: bigint }[]>`
      SELECT COALESCE(sum(bytes), 0)::bigint AS bytes
        FROM assistant_upload
       WHERE conversation_id = ${upload.conversationId}::uuid AND state <> 'expired'
    `;
    if (Number(total?.bytes ?? 0) + size > MAX_CONVERSATION_BYTES) {
      throw new HttpError(409, `this conversation's files add up to at most ${describeBytes(MAX_CONVERSATION_BYTES)}`, {
        reason: "conversation_full" satisfies UploadRefusal
      });
    }
    const created = await tx.assistantUpload.create({
      data: {
        conversationId: upload.conversationId,
        ownerOid: upload.ownerOid,
        fileName: fileNameOf(upload.name),
        storedName: storedNameOf(upload.name),
        mediaType,
        bytes: BigInt(size)
      },
      select: { id: true }
    });
    return { uploadId: created.id, partBytes: PART_BYTES, parts: partCount(size) };
  });
}

/**
 * Stores one part and answers how much of the file has arrived. The same part sent twice replaces itself, so a client
 * that retries after a lost response is not left with a gap.
 *
 * `received` is worked out from the part *indices*, not from the stored bytes: every part but the last is exactly
 * `PART_BYTES`, so the arithmetic needs no `octet_length`, which would have to read every part back out of TOAST.
 */
export async function putUploadPart(prisma: PrismaClient, upload: UploadRow, index: number, data: UploadBytes): Promise<{ received: number }> {
  const expected = partLength(upload.bytes, index);
  if (data.byteLength !== expected) {
    throw new HttpError(400, `part ${index} of this file is ${expected} bytes`, { reason: "part_wrong_length" satisfies UploadRefusal });
  }
  return await prisma.$transaction(async (tx) => {
    // The browser sends parts in parallel, and two of them counting what has arrived at once would each see a
    // snapshot without the other's row — leaving a complete upload `pending` for ever. Taking the upload's row first
    // serialises the parts of one file and nothing else, so other files still go up at the same time.
    await tx.$executeRaw`SELECT 1 FROM assistant_upload WHERE id = ${upload.id}::uuid FOR UPDATE`;
    await tx.assistantUploadPart.upsert({
      where: { uploadId_index: { uploadId: upload.id, index } },
      create: { uploadId: upload.id, index, data },
      update: { data }
    });
    const [arrived] = await tx.$queryRaw<{ parts: bigint; received: bigint }[]>`
      SELECT count(*)::bigint AS parts,
             COALESCE(sum(LEAST(${PART_BYTES}::bigint, ${BigInt(upload.bytes)}::bigint - index::bigint * ${PART_BYTES}::bigint)), 0)::bigint AS received
        FROM assistant_upload_part
       WHERE upload_id = ${upload.id}::uuid
    `;
    const received = Number(arrived?.received ?? 0);
    if (Number(arrived?.parts ?? 0) === partCount(upload.bytes)) {
      await tx.assistantUpload.update({ where: { id: upload.id }, data: { state: "stored", updatedAt: new Date() } });
    }
    return { received };
  });
}

/** Throws away a pending upload and its parts. Nothing announces it: only the tab that made it knows it existed. */
export async function discardUpload(prisma: PrismaClient, uploadId: string): Promise<void> {
  await prisma.assistantUpload.delete({ where: { id: uploadId } });
}

/** The upload the caller may write to, or the refusal. One place, so every browser-facing route refuses alike. */
export async function writableUpload(prisma: PrismaClient, viewerOid: string, uploadId: string): Promise<UploadRow> {
  const upload = await findUpload(prisma, uploadId);
  if (upload === undefined || !canWriteUpload(viewerOid, upload)) {
    // The same answer for someone else's upload as for one that never existed: an id is not worth confirming.
    throw new UploadNotFound();
  }
  return upload;
}

/**
 * Stamps `messageId` on each upload, inside the transaction that inserted the message. Any id that is not `stored`,
 * belongs to another conversation or another person, or already carries a message, refuses the whole send: half a
 * message's attachments is worse than none, because the person cannot tell which half the agent got.
 */
export async function attachUploads(
  db: Database,
  attach: { viewerOid: string; conversationId: string; messageId: bigint; uploadIds: readonly string[] }
): Promise<void> {
  if (attach.uploadIds.length === 0) {
    return;
  }
  if (attach.uploadIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new HttpError(400, `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files`);
  }
  if (new Set(attach.uploadIds).size !== attach.uploadIds.length) {
    throw new HttpError(400, "the same file is attached twice");
  }
  for (const uploadId of attach.uploadIds) {
    const upload = await findUpload(db, uploadId);
    if (upload === undefined || !canAttachUpload(attach.viewerOid, attach.conversationId, upload)) {
      throw new HttpError(400, "one of those files is not ready to send; remove it and attach it again");
    }
    // The rule is asked again in the `where`, so the claim is the same statement as the check: two tabs sending the
    // same file at once would otherwise both read it as unclaimed and the second would take it off the first's
    // message. Nothing claimed means the rule stopped holding in between, which refuses the send as it would have.
    const claimed = await db.assistantUpload.updateMany({
      where: { id: uploadId, conversationId: attach.conversationId, ownerOid: attach.viewerOid, messageId: null, state: "stored" },
      data: { messageId: attach.messageId, updatedAt: new Date() }
    });
    if (claimed.count !== 1) {
      throw new HttpError(409, "one of those files was sent on another message; remove it and attach it again");
    }
  }
}

/**
 * The names of the uploads a send names, in the order it names them, for wording a message the person left empty.
 *
 * Read before the message is written, because the body has to be decided before the insert, while `attachUploads` is
 * what claims them inside its transaction. Nothing is trusted to this: an id that is not ready, not this person's or
 * not this conversation's is simply absent, and the caller refuses the send exactly as the claim would have.
 */
export async function uploadNames(db: Database, viewerOid: string, conversationId: string, uploadIds: readonly string[]): Promise<string[]> {
  const ids = uploadIds.filter((id) => UUID.test(id));
  const rows = await db.assistantUpload.findMany({
    where: { id: { in: ids }, ownerOid: viewerOid, conversationId, messageId: null, state: "stored" },
    select: { id: true, fileName: true }
  });
  const named = new Map(rows.map((row) => [row.id, row.fileName]));
  return uploadIds.flatMap((id) => {
    const name = named.get(id);
    return name === undefined ? [] : [name];
  });
}

/** The attachments of a message, oldest first, for the thread. Empty for a message with none. */
export async function messageAttachments(db: Database, messageId: bigint): Promise<MessageAttachment[]> {
  const rows = await db.assistantUpload.findMany({
    where: { messageId },
    select: { id: true, fileName: true, bytes: true, mediaType: true },
    orderBy: { createdAt: "asc" }
  });
  return rows.map((row) => ({ id: row.id, name: row.fileName, bytes: Number(row.bytes), media_type: row.mediaType }));
}

/** The attachments a `direct` frame names, so the pod can fetch each one part by part before the message is delivered. */
export async function frameAttachments(db: Database, messageId: bigint): Promise<FrameAttachment[]> {
  const rows = await db.assistantUpload.findMany({
    where: { messageId, state: { in: ["stored", "fetched"] } },
    select: { id: true, storedName: true, bytes: true, mediaType: true },
    orderBy: { createdAt: "asc" }
  });
  return rows.map((row) => {
    const bytes = Number(row.bytes);
    return { upload_id: row.id, name: row.storedName, bytes, media_type: row.mediaType, part_bytes: PART_BYTES, parts: partCount(bytes) };
  });
}

/** The attachment a conversation's session may act on, or the refusal. The pod-facing half of `writableUpload`. */
export async function sessionAttachment(prisma: PrismaClient, conversationId: string | null, uploadId: string, use: "part" | "fetched"): Promise<UploadRow> {
  const upload = await findUpload(prisma, uploadId);
  if (upload === undefined || !canSessionUseAttachment(conversationId, upload, use)) {
    throw new UploadNotFound();
  }
  return upload;
}

/** One part's bytes, or `undefined` when there is no such part. Exactly one part is ever in memory here. */
export async function readUploadPart(db: Database, uploadId: string, index: number): Promise<UploadBytes | undefined> {
  const row = await db.assistantUploadPart.findUnique({ where: { uploadId_index: { uploadId, index } }, select: { data: true } });
  return row === null ? undefined : row.data;
}

/**
 * The pod has the whole file on its disk. **Deletes every part row**, which is what stops Postgres holding bytes, and
 * keeps the metadata row so the thread can still show the file. Already `fetched` changes nothing.
 */
export async function reportFetched(prisma: PrismaClient, uploadId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.assistantUploadPart.deleteMany({ where: { uploadId } });
    await tx.assistantUpload.update({ where: { id: uploadId }, data: { state: "fetched", updatedAt: new Date() } });
  });
}
