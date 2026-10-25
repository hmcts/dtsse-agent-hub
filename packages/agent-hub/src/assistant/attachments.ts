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

/**
 * The attachments on a frame, as this client is willing to act on them. Anything missing, out of range or of the wrong
 * type is dropped: the frame comes from a hub that may be older or newer than this client, and a half-understood
 * attachment is worse than none, because the message would name a path that holds the wrong bytes.
 */
export function parseAttachments(value: unknown, partBytesFallback?: number): Attachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Attachment[] = [];
  for (const entry of value.slice(0, MAX_ATTACHMENTS)) {
    const raw = asRecord(entry);
    if (!raw || typeof raw.upload_id !== "string" || !UUID.test(raw.upload_id) || typeof raw.name !== "string" || raw.name === "") {
      continue;
    }
    const bytes = raw.bytes;
    const partBytes = typeof raw.part_bytes === "number" ? raw.part_bytes : partBytesFallback;
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_ATTACHMENT_BYTES) {
      continue;
    }
    if (typeof partBytes !== "number" || !Number.isInteger(partBytes) || partBytes < 1) {
      continue;
    }
    const parts = typeof raw.parts === "number" && Number.isInteger(raw.parts) && raw.parts > 0 ? raw.parts : Math.ceil(bytes / partBytes);
    if (parts !== Math.ceil(bytes / partBytes)) {
      continue;
    }
    out.push({
      uploadId: raw.upload_id,
      name: raw.name,
      bytes,
      mediaType: typeof raw.media_type === "string" && raw.media_type !== "" ? raw.media_type : "application/octet-stream",
      parts
    });
  }
  return out;
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
    try {
      const file = attachmentPath(base, conversationId, attachment.uploadId, attachment.name);
      // Already here at its full length: a message the hub replayed because the last delivery was not acked. Fetching
      // again would fail, since the report deleted the parts, and would then tell the session a file it has could not
      // be retrieved.
      if (sizeOf(file, fs) !== attachment.bytes) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const written = await writeParts({ api, agentId, attachment, file, fs });
        if (written !== attachment.bytes) {
          throw new Error(`wrote ${written} bytes of an expected ${attachment.bytes}`);
        }
        await api.attachmentFetched(agentId, attachment.uploadId);
        say(`conversation ${conversationId}: saved ${attachment.name} to ${file}`);
      }
      outcomes.push({ name: safeName(attachment.name), path: file, media_type: attachment.mediaType, bytes: attachment.bytes });
    } catch (e) {
      const reason = (e as Error).message;
      say(`conversation ${conversationId}: could not fetch ${attachment.name}: ${reason}`);
      outcomes.push({ name: safeName(attachment.name), media_type: attachment.mediaType, bytes: attachment.bytes, error: reason });
    }
  }
  return outcomes;
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
