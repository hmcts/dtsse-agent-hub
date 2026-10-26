// Files the person attached to an Assistant message, pulled from the hub to this pod's disk before the message is
// delivered. The hub never calls a pod, so every byte comes this way round: the frame names each file, this module
// fetches it part by part, and the envelope then names the absolute path — so nothing depends on the model choosing
// to go and look for it.
import nodeFs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../agent.ts";
import type { Api } from "../api.ts";
import type { Env } from "../env.ts";
import type { AttachmentOutcome } from "../envelope.ts";

/** What the hub says about one attachment, once this client has checked every field of it. */
export type Attachment = {
  uploadId: string;
  name: string;
  bytes: number;
  mediaType: string;
  parts: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 100;
/** The same cap the hub puts on a file, so a frame claiming more is a frame this client does not act on. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;

/**
 * A name safe to put in a path. The hub already decided it and its own CHECK constraint enforces the same shape, so
 * this is the second of two independent sanitisers — deliberately, because a path is the one thing a pod must not
 * take from the network on trust. Nothing but letters, digits, dots, hyphens and underscores survives, and the first
 * character is always a letter or digit, so neither a separator, a `..` segment nor a dotfile can be produced.
 */
export function safeName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, MAX_NAME);
  return cleaned === "" ? "file" : cleaned;
}

/** Where attachments live: on the persistent volume, beside the workspace checkout rather than inside it. */
export function uploadsRoot(env: Env = process.env, cwd: string = workspaceRoot()): string {
  return env.AGENT_HUB_UPLOADS_DIR?.trim() || path.join(path.dirname(path.resolve(cwd)), "uploads");
}

/** One conversation's directory. A conversation id that is not a UUID is refused rather than made into a path. */
export function conversationDir(root: string, conversationId: string): string {
  if (!UUID.test(conversationId)) {
    throw new Error(`${conversationId} is not a conversation id`);
  }
  return path.join(path.resolve(root), conversationId.toLowerCase());
}

/**
 * The file an attachment is written to: a pure function of the conversation id, the upload id and the stored name,
 * asserted to resolve inside the conversation's own directory. The assertion is the point — it is what makes this
 * safe even if `safeName` were one day loosened.
 */
export function attachmentPath(root: string, conversationId: string, uploadId: string, name: string): string {
  if (!UUID.test(uploadId)) {
    throw new Error(`${uploadId} is not an upload id`);
  }
  const dir = conversationDir(root, conversationId);
  const file = path.resolve(dir, `${uploadId.toLowerCase()}-${safeName(name)}`);
  if (!file.startsWith(`${dir}${path.sep}`)) {
    throw new Error(`${name} would not be written inside ${dir}`);
  }
  return file;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** What a frame's `attachments` came to: the entries this client will act on, and an outcome for each it will not. */
export type ReadAttachments = {
  attachments: Attachment[];
  /** Error outcomes for the entries that were refused, so the envelope says a file was lost rather than nothing. */
  dropped: AttachmentOutcome[];
};

/** The name to put on a refused entry's outcome, for an entry whose `name` is not a string this client can use. */
function droppedName(entry: unknown): string {
  const raw = asRecord(entry);
  return raw !== null && typeof raw.name === "string" && raw.name !== "" ? safeName(raw.name) : "an unnamed file";
}

/**
 * One entry of a frame's `attachments`: the file to fetch, or the reason this client will not act on it.
 *
 * Each check has a reason of its own because each reason is something the person can be told. They are asked in the
 * order a fetch would need them — an id and a name to build the path, then a length, then the parts to read it in.
 */
function readEntry(entry: unknown, partBytesFallback: number | undefined): { attachment: Attachment } | { refusal: string } {
  const raw = asRecord(entry);
  if (!raw || typeof raw.upload_id !== "string" || !UUID.test(raw.upload_id) || typeof raw.name !== "string" || raw.name === "") {
    return { refusal: "this client could not read the file's id or name on the frame" };
  }
  const bytes = raw.bytes;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_ATTACHMENT_BYTES) {
    return { refusal: "the frame gave a size this client cannot fetch" };
  }
  const partBytes = typeof raw.part_bytes === "number" ? raw.part_bytes : partBytesFallback;
  if (typeof partBytes !== "number" || !Number.isInteger(partBytes) || partBytes < 1) {
    return { refusal: "the frame gave no part size this client could use" };
  }
  const parts = typeof raw.parts === "number" && Number.isInteger(raw.parts) && raw.parts > 0 ? raw.parts : Math.ceil(bytes / partBytes);
  if (parts !== Math.ceil(bytes / partBytes)) {
    return { refusal: "the frame's part count does not match its size" };
  }
  const mediaType = typeof raw.media_type === "string" && raw.media_type !== "" ? raw.media_type : "application/octet-stream";
  return { attachment: { uploadId: raw.upload_id, name: raw.name, bytes, mediaType, parts } };
}

/**
 * The attachments on a frame, as this client is willing to act on them, and an error outcome for each entry it is not.
 *
 * Anything missing, out of range or of the wrong type is refused: the frame comes from a hub that may be older or
 * newer than this client, and a half-understood attachment is worse than acting on none of it, because the message
 * would name a path that holds the wrong bytes. But refusing it is not the same as dropping it — an entry that was on
 * the frame is a file the person attached, so it comes back as an outcome the envelope names and says could not be
 * retrieved. Today the hub's caps and the checks here agree and nothing reaches this, which is exactly why the
 * outcome matters: the one frame that ever does disagree must not deliver in silence.
 *
 * Entries past `MAX_ATTACHMENTS` are the exception, and are left out with nothing said. The hub refuses a message
 * carrying more than that on the send and again on the claim, so a longer array is not a disagreement about one file
 * but a hub this client does not understand at all, and an unbounded array would otherwise word an unbounded envelope.
 */
export function readAttachments(value: unknown, partBytesFallback?: number): ReadAttachments {
  if (!Array.isArray(value)) {
    return { attachments: [], dropped: [] };
  }
  const attachments: Attachment[] = [];
  const dropped: AttachmentOutcome[] = [];
  for (const entry of value.slice(0, MAX_ATTACHMENTS)) {
    const read = readEntry(entry, partBytesFallback);
    if ("refusal" in read) {
      dropped.push({ name: droppedName(entry), error: read.refusal });
    } else {
      attachments.push(read.attachment);
    }
  }
  return { attachments, dropped };
}

/** Just the attachments this client will act on, for the callers that have nothing to say about the rest. */
export function parseAttachments(value: unknown, partBytesFallback?: number): Attachment[] {
  return readAttachments(value, partBytesFallback).attachments;
}

/**
 * Error outcomes for attachments this pod cannot even attempt to fetch, so the envelope names each file and says it
 * could not be retrieved. Delivering the message with them left out would read as though nothing had been attached.
 */
export function unfetchedAttachments(attachments: readonly Attachment[], reason: string): AttachmentOutcome[] {
  return attachments.map((attachment) => ({
    name: safeName(attachment.name),
    media_type: attachment.mediaType,
    bytes: attachment.bytes,
    error: reason
  }));
}

/** The filesystem calls this module makes; a test passes `node:fs` or its own. */
export type AttachmentFs = Pick<typeof nodeFs, "mkdirSync" | "openSync" | "writeSync" | "closeSync" | "statSync" | "rmSync" | "readdirSync" | "existsSync">;

/** The file's length, or `undefined` when it is not there. */
function sizeOf(file: string, fs: AttachmentFs): number | undefined {
  try {
    return fs.statSync(file).size;
  } catch {
    return undefined;
  }
}

export type FetchAttachmentsOptions = {
  api: Pick<Api, "attachmentPart" | "attachmentFetched">;
  agentId: string;
  conversationId: string;
  attachments: readonly Attachment[];
  root?: string;
  fs?: AttachmentFs;
  env?: Env;
  say?: (message: string) => void;
};

/**
 * Writes each attachment to disk and reports it fetched, answering what the envelope should say about each.
 *
 * Part by part, straight into the open file: the pod holds one part at a time, as the hub does, so neither end ever
 * has the whole file in memory. The byte count is checked against what the frame claimed before anything is reported
 * fetched, because the report is what makes the hub throw the bytes away — there is no second chance at them.
 *
 * **A failure here never stops the message.** It comes back as an outcome with `error`, which the envelope turns into
 * a line telling the session the file could not be retrieved. Silently dropping it would leave the person believing
 * the agent had read their file.
 */
export async function fetchAttachments({
  api,
  agentId,
  conversationId,
  attachments,
  root,
  fs = nodeFs,
  env = process.env,
  say = () => {}
}: FetchAttachmentsOptions): Promise<AttachmentOutcome[]> {
  const base = root ?? uploadsRoot(env);
  const outcomes: AttachmentOutcome[] = [];
  for (const attachment of attachments) {
    let file: string | undefined;
    try {
      file = attachmentPath(base, conversationId, attachment.uploadId, attachment.name);
      // Already here at its full length: a message the hub replayed because the last delivery was not acked. Fetching
      // again would fail, since the report deleted the parts, and would then tell the session a file it has could not
      // be retrieved.
      if (sizeOf(file, fs) !== attachment.bytes) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const written = await writeParts({ api, agentId, attachment, file, fs });
        if (written !== attachment.bytes) {
          throw new Error(`wrote ${written} bytes of an expected ${attachment.bytes}`);
        }
        await reportFetched({ api, agentId, uploadId: attachment.uploadId, name: attachment.name, conversationId, say });
        say(`conversation ${conversationId}: saved ${attachment.name} to ${file}`);
      }
      outcomes.push({ name: safeName(attachment.name), path: file, media_type: attachment.mediaType, bytes: attachment.bytes });
    } catch (e) {
      const reason = (e as Error).message;
      // Nothing half-written left at the path. An error outcome carries no `path`, so the envelope never names it, but
      // the file is in the conversation's uploads directory and a session listing that directory would find it and
      // read it as the attachment — an empty file for a refused first part, a truncated one for a refused later part.
      // Guarded on the length rather than on how far the fetch got: a file at its full claimed length is the one a
      // replay reuses, and must survive whatever else went wrong.
      if (file !== undefined && sizeOf(file, fs) !== attachment.bytes) {
        fs.rmSync(file, { force: true });
      }
      say(`conversation ${conversationId}: could not fetch ${attachment.name}: ${reason}`);
      outcomes.push({ name: safeName(attachment.name), media_type: attachment.mediaType, bytes: attachment.bytes, error: reason });
    }
  }
  return outcomes;
}

/**
 * Tells the hub the bytes are on this disk, which is what lets it delete its part rows.
 *
 * Best effort relative to the outcome, and deliberately so: by the time this runs the file is written and its length
 * checked, so the outcome is a success whatever the hub answers. Letting a transient 5xx or a dropped connection
 * reach the caller's `catch` would label a file that is sitting there, complete and readable, as one that "could not
 * be retrieved and is not on this machine" — telling the person to attach it again for nothing. A report that failed
 * costs the hub its part rows a while longer, and its sweep is the backstop for those.
 */
async function reportFetched({
  api,
  agentId,
  uploadId,
  name,
  conversationId,
  say
}: {
  api: Pick<Api, "attachmentFetched">;
  agentId: string;
  uploadId: string;
  name: string;
  conversationId: string;
  say: (message: string) => void;
}): Promise<void> {
  try {
    await api.attachmentFetched(agentId, uploadId);
  } catch (e) {
    say(`conversation ${conversationId}: saved ${name}, but could not report it fetched: ${(e as Error).message}`);
  }
}

async function writeParts({
  api,
  agentId,
  attachment,
  file,
  fs
}: {
  api: Pick<Api, "attachmentPart">;
  agentId: string;
  attachment: Attachment;
  file: string;
  fs: AttachmentFs;
}): Promise<number> {
  // 0o600: the volume is the owner's, but it is also the pod's own `claude` session's, so nothing here is group- or
  // world-readable by accident.
  const handle = fs.openSync(file, "w", 0o600);
  try {
    let written = 0;
    for (let index = 0; index < attachment.parts; index += 1) {
      const part = await api.attachmentPart(agentId, attachment.uploadId, index);
      written += fs.writeSync(handle, part, 0, part.byteLength, written);
      if (written > attachment.bytes) {
        throw new Error(`part ${index} took the file past the expected ${attachment.bytes} bytes`);
      }
    }
    return written;
  } finally {
    fs.closeSync(handle);
  }
}

/** `<upload_id>-<anything>` inside a conversation's directory: what one attachment was written as. */
function isCopyOf(name: string, uploadId: string): boolean {
  return name.toLowerCase().startsWith(`${uploadId.toLowerCase()}-`);
}

/**
 * The upload ids a `delete_uploads` frame names, as this client will act on them. Pure, so the decision is testable
 * without a filesystem. Anything that is not a conversation id or an upload id is dropped: a path is the one thing a
 * pod must not take from the network on trust, and `attachmentPath` would refuse it a second time anyway.
 */
export function readDeleteUploads(value: unknown): { conversationId: string; uploadIds: string[] } | undefined {
  const raw = asRecord(value);
  if (raw === null || typeof raw.conversation_id !== "string" || !UUID.test(raw.conversation_id)) {
    return undefined;
  }
  const ids = Array.isArray(raw.upload_ids) ? raw.upload_ids : [];
  const uploadIds = ids.filter((id): id is string => typeof id === "string" && UUID.test(id)).map((id) => id.toLowerCase());
  return uploadIds.length === 0 ? undefined : { conversationId: raw.conversation_id.toLowerCase(), uploadIds };
}

export type DeleteUploadsOptions = {
  conversationId: string;
  uploadIds: readonly string[];
  root?: string;
  fs?: AttachmentFs;
  env?: Env;
  say?: (message: string) => void;
};

/**
 * Deletes this pod's copies of the uploads the hub named, because the person asked for them. Answers how many files
 * it removed.
 *
 * A file that is not there is counted as removed: the request is replayed until the pod's next report shows it gone,
 * so acting on one twice has to be as good as acting on it once. The directory itself is left alone — the
 * conversation still exists, and `close` is what empties it.
 *
 * It matches on the `<upload_id>-` prefix rather than rebuilding the name from the frame, because the name the file
 * was written with came from a frame sent at upload time and `storedNameOf` may since have been changed.
 */
export function deleteUploads({ conversationId, uploadIds, root, fs = nodeFs, env = process.env, say = () => {} }: DeleteUploadsOptions): number {
  const dir = conversationDir(root ?? uploadsRoot(env), conversationId);
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let removed = 0;
  const present = fs.readdirSync(dir) as string[];
  for (const uploadId of uploadIds) {
    for (const name of present.filter((file) => isCopyOf(file, uploadId))) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed += 1;
      } catch (e) {
        say(`could not delete ${name} of conversation ${conversationId}: ${(e as Error).message}`);
      }
    }
  }
  say(`conversation ${conversationId}: deleted ${removed} file(s) the person asked to remove`);
  return removed;
}

/** Removes a conversation's attachments, for a conversation that has been deleted. Missing is success. */
export function removeConversationUploads(root: string, conversationId: string, fs: Pick<AttachmentFs, "rmSync"> = nodeFs): void {
  fs.rmSync(conversationDir(root, conversationId), { recursive: true, force: true });
}

/**
 * The directories under the uploads root that no live conversation owns. Pure, so the decision is testable without a
 * filesystem: `present` is what is on disk, `live` what the hub says exists. Anything whose name is not a conversation
 * id is left alone — it is not this module's to delete.
 */
export function staleUploadDirs(present: readonly string[], live: readonly string[]): string[] {
  const alive = new Set(live.map((id) => id.toLowerCase()));
  return present.filter((name) => UUID.test(name) && !alive.has(name.toLowerCase()));
}

export type ReconcileUploadsOptions = {
  api: Pick<Api, "conversations">;
  id: string;
  root?: string;
  fs?: AttachmentFs;
  env?: Env;
  say?: (message: string) => void;
};

/**
 * Deletes the attachments of conversations the hub no longer has. The sessions stream's `close` covers a conversation
 * deleted while this pod is up; this covers one deleted while it was stopped, which sends no `close` anybody heard.
 *
 * Answers how many directories it removed. A read of the hub that fails removes nothing: an empty conversation list
 * that is really a network error must not be read as "delete everything".
 */
export async function reconcileUploads({ api, id, root, fs = nodeFs, env = process.env, say = () => {} }: ReconcileUploadsOptions): Promise<number> {
  const base = root ?? uploadsRoot(env);
  if (!fs.existsSync(base)) {
    return 0;
  }
  let live: string[];
  try {
    live = (await api.conversations(id)).conversations.map((conversation) => conversation.id);
  } catch (e) {
    say(`could not read the conversation list to reconcile uploads: ${(e as Error).message}`);
    return 0;
  }
  let removed = 0;
  for (const name of staleUploadDirs(fs.readdirSync(base) as string[], live)) {
    try {
      removeConversationUploads(base, name, fs);
      removed += 1;
      say(`removed the uploads of conversation ${name}, which the hub no longer has`);
    } catch (e) {
      say(`could not remove the uploads of conversation ${name}: ${(e as Error).message}`);
    }
  }
  return removed;
}
