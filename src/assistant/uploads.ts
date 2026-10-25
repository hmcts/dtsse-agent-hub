/**
 * What a person may attach to an Assistant message, and how the hub cuts it up. Pure, and shared by the browser-facing
 * routes, the pod-facing routes, the sweep and the frame, so there is one answer to every size question.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Off unless set to exactly `true`. Load-bearing rather than hygiene: nothing reports a pod's client version, so the
 * hub cannot tell whether a pod understands an `attachments` frame, and a pod on an older client would never fetch the
 * file and never say so — leaving the person believing the agent had read it.
 */
export function uploadsEnabled(env: Environment = process.env): boolean {
  return env.ASSISTANT_UPLOADS_ENABLED === "true";
}

/** 25 MB, the largest single file. Every byte of it crosses the hub's heap and its database. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * How much of a file one request carries.
 *
 * Traefik's `readTimeout` is 30 seconds (`platops/cnp-flux-config/apps/admin/traefik2/traefik2.yaml`) and that budget
 * covers the body arriving, not just the headers. 25 MB inside it needs a sustained ~7 Mbit/s, which the VPN does not
 * reliably give, so the file is sent in pieces this size instead. **Raising this silently breaks slow connections** —
 * the upload simply times out part-way, with nothing on either side saying why — so change the Traefik timeout first.
 */
export const PART_BYTES = 4 * 1024 * 1024;

/** At most this many files on one message, so a single send cannot queue 25 MB × anything at the pod. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/**
 * Everything a conversation's files may add up to, counting what the pod has already fetched: the pod's `/workspace`
 * is shared with its repository clones, and filling it breaks those rather than just the uploads.
 */
export const MAX_CONVERSATION_BYTES = 200 * 1024 * 1024;

export const MAX_FILE_NAME = 255;

/** As long as the `stored_name` CHECK in the `assistant_upload` migration allows. */
export const MAX_STORED_NAME = 100;

/** How many parts a file of `bytes` is sent in. A zero-byte file is refused before this is asked. */
export function partCount(bytes: number): number {
  return Math.ceil(bytes / PART_BYTES);
}

/** The length of part `index` of a file of `bytes`: a full part, or whatever is left over in the last one. */
export function partLength(bytes: number, index: number): number {
  return Math.min(PART_BYTES, bytes - index * PART_BYTES);
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,62}\/[a-z0-9][a-z0-9.+-]{0,62}$/;

/** A media type the browser may claim. Only the shape is checked: the bytes are never trusted to match it. */
export function isMediaType(value: unknown): value is string {
  return typeof value === "string" && MEDIA_TYPE.test(value.toLowerCase());
}

export const DEFAULT_MEDIA_TYPE = "application/octet-stream";

const EXTENSION = /\.[A-Za-z0-9]{1,16}$/;

/**
 * The name the pod writes the file as, from the name the browser sent. The hub decides it and that decision is
 * authoritative; the pod re-sanitises anyway, because a path is the one thing it must not take on trust.
 *
 * Everything but letters, digits, dots, hyphens and underscores becomes `_`, so no separator, no `..` segment and no
 * control character survives; a leading character that is not a letter or digit is dropped, so the result can never be
 * a dotfile. The extension is kept when the name has to be cut, because that is what tells the session what the file is.
 */
export function storedNameOf(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const cleaned = raw
    .normalize("NFC")
    .slice(-MAX_FILE_NAME)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "");
  if (cleaned === "") {
    return "file";
  }
  if (cleaned.length <= MAX_STORED_NAME) {
    return cleaned;
  }
  const extension = EXTENSION.exec(cleaned)?.[0] ?? "";
  return `${cleaned.slice(0, MAX_STORED_NAME - extension.length)}${extension}`;
}

/** Whether a character is a C0 control or DEL, as `unsafeInAPath` in `src/auth/guard.ts` asks the same question. */
function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

/**
 * The name the thread shows, as the person's own file was called, keeping its spaces and accents. Only control
 * characters go, and by code point rather than by a regular expression, which would have to spell them out.
 */
export function fileNameOf(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const cleaned = [...raw.normalize("NFC")]
    .filter((character) => !isControl(character))
    .join("")
    .trim()
    .slice(0, MAX_FILE_NAME);
  return cleaned === "" ? "file" : cleaned;
}

/** A whole number of bytes a file could be. Anything else is a bad request rather than something to clamp. */
export function isUploadSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_UPLOAD_BYTES;
}

/** A part number inside a file of `bytes`, from a path segment. `undefined` for anything else. */
export function partIndexOf(value: string, bytes: number): number | undefined {
  if (!/^\d{1,4}$/.test(value)) {
    return undefined;
  }
  const index = Number(value);
  return index < partCount(bytes) ? index : undefined;
}

/**
 * Why an upload was refused, carried beside the `error` sentence as `reason`.
 *
 * The composer words each of these for the person itself, which is what the discriminator is for: two of them are
 * `409`, and "you have attached four files already" and "this chat has no room left" are different things to be told
 * and must not be told in the same words. Matching on the sentence instead would break the moment a cap is reworded.
 */
export type UploadRefusal =
  /** The deployment has `ASSISTANT_UPLOADS_ENABLED` off, so there is nothing to attach to. */
  | "unavailable"
  | "no_such_conversation"
  /** No such upload, or someone else's: the two are deliberately indistinguishable. */
  | "no_such_upload"
  | "file_too_big"
  /** `MAX_ATTACHMENTS_PER_MESSAGE` files are already waiting on this conversation's next message. */
  | "too_many_files"
  /** The conversation's files would pass `MAX_CONVERSATION_BYTES`, which the browser cannot know in advance. */
  | "conversation_full"
  | "part_too_big"
  | "part_wrong_length";

/** The body of a refused upload request: the contract's `error`, and the reason the composer words. */
export interface UploadRefusalBody {
  error: string;
  reason?: UploadRefusal;
}

/**
 * The message a person sends by attaching files and typing nothing at all.
 *
 * Every message in the hub has words, and not only by convention: `message_body_present` is a `CHECK (length(body) >
 * 0)` on the `message` table, which protects every topic post and every agent's direct as well, and is not worth
 * loosening for this one case. A body of nothing would be no use to the session either — `assistantEnvelope` ends
 * with it, so the session would be handed paths and no ask.
 *
 * So the hub writes the obvious sentence instead. It is true, it is what attaching a file means, and it is what the
 * thread then shows above the chips.
 */
export function attachedBody(names: readonly string[]): string {
  if (names.length === 0) {
    return "";
  }
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `I have attached ${listed}. Please take a look.`;
}

/** `25 MB`, `4 MiB`: for a refusal a person reads, not a log line. */
export function describeBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}
