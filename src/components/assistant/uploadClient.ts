"use client";

/**
 * The browser half of an attachment upload: what the person is allowed to attach, how a file is cut into parts, and
 * the three calls that carry it to the hub. Same-origin and authenticated by the `ah_session` cookie, so there is no
 * token to carry and nothing to configure.
 *
 * Parts go through `XMLHttpRequest` rather than `fetch`, because `fetch` reports no progress while a request body is
 * being sent in any shipping browser, and a 4 MiB part over VPN takes long enough that a person needs to see it move.
 */

/**
 * 4 MiB. Traefik gives one request 30 seconds to arrive, body included
 * (`platops/cnp-flux-config/apps/admin/traefik2/`), and a whole 25 MB file does not reliably arrive in that over VPN.
 * The hub answers `createUpload` with the size it actually wants; this is the fallback and the figure the UI plans
 * progress against.
 */
export const PART_BYTES = 4 * 1024 * 1024;

/** The largest file the hub accepts. It checks this too; here it buys a decent sentence instead of a failed request. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** How many files one message may carry. */
export const MAX_FILES = 4;

export interface CreatedUpload {
  uploadId: string;
  partBytes: number;
}

/** One part's place in the file: `[start, end)` of the whole, sent as part `index`. */
export interface PartRange {
  index: number;
  start: number;
  end: number;
}

/** Thrown when the person removed the attachment, or sent the message, while a part was in flight. */
export class UploadAborted extends Error {
  constructor() {
    super("the upload was stopped");
    this.name = "UploadAborted";
  }
}

/** A file's size in words a person reads, rather than a byte count. */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) {
    return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  }
  const kilobytes = bytes / 1024;
  if (kilobytes < 1000) {
    return `${Math.round(kilobytes)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "a.pdf", "a.pdf and b.pdf", "a.pdf, b.pdf and c.pdf". */
function listNames(names: readonly string[]): string {
  if (names.length < 2) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface Candidate {
  name: string;
  size: number;
}

/**
 * Which of the files the person chose may be attached, and what to tell them about the rest. Going over the count
 * takes the whole batch, because keeping an arbitrary few of them would be a silent choice made for them; an
 * over-size or empty file is refused on its own and the others still go.
 */
export function admitFiles<T extends Candidate>(attached: number, chosen: readonly T[]): { accepted: T[]; refusal: string | null } {
  if (attached + chosen.length > MAX_FILES) {
    return { accepted: [], refusal: `You can attach up to ${MAX_FILES} files to a message.` };
  }
  const tooBig = chosen.filter((file) => file.size > MAX_FILE_BYTES);
  const empty = chosen.filter((file) => file.size === 0);
  const refusals: string[] = [];
  if (tooBig.length > 0) {
    refusals.push(`${listNames(tooBig.map((file) => file.name))} ${tooBig.length === 1 ? "is" : "are"} too big. Each file must be 25 MB or less.`);
  }
  if (empty.length > 0) {
    refusals.push(`${listNames(empty.map((file) => file.name))} ${empty.length === 1 ? "is" : "are"} empty, so there is nothing to attach.`);
  }
  return {
    accepted: chosen.filter((file) => file.size > 0 && file.size <= MAX_FILE_BYTES),
    refusal: refusals.length === 0 ? null : refusals.join(" ")
  };
}

/** The parts of a file of `size`, in the order they must be sent. */
export function partRanges(size: number, partBytes: number): PartRange[] {
  const ranges: PartRange[] = [];
  for (let start = 0; start < size; start += partBytes) {
    ranges.push({ index: ranges.length, start, end: Math.min(start + partBytes, size) });
  }
  return ranges;
}

/**
 * A name for a file that arrived without one. A screenshot pasted from the clipboard is nameless `image/png`, and
 * "image.png" four times over tells the person nothing about which is which.
 */
export function pastedName(name: string, mediaType: string, at: Date): string {
  if (name.trim() !== "") {
    return name;
  }
  const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const extension = /^[a-z]+\/([a-z0-9]+)/.exec(mediaType)?.[1] ?? "bin";
  return `screenshot-${stamp}.${extension}`;
}

/** What the hub sends when it refuses, or a sentence built from the status when the body is not its usual shape. */
function refusalIn(body: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function isCreated(body: unknown): body is CreatedUpload {
  return (
    typeof body === "object" &&
    body !== null &&
    "uploadId" in body &&
    typeof body.uploadId === "string" &&
    "partBytes" in body &&
    typeof body.partBytes === "number"
  );
}

/** Claims an upload and its size of part. The hub decides the stored name, so the one sent here is only a request. */
export async function createUpload(
  input: { conversationId: string; name: string; size: number; mediaType: string },
  signal?: AbortSignal
): Promise<CreatedUpload> {
  const response = await fetch("/api/ui/uploads", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
    signal
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(refusalIn(body, `the file could not be attached (${response.status})`));
  }
  const parsed: unknown = JSON.parse(body);
  if (!isCreated(parsed)) {
    throw new Error("the hub did not say where to send the file");
  }
  return { uploadId: parsed.uploadId, partBytes: parsed.partBytes };
}

/** Sends one part, reporting the bytes of it that have left the browser. Resolves only once the hub has it. */
export function putPart(
  uploadId: string,
  index: number,
  part: Blob,
  options: { signal?: AbortSignal; onProgress?: (loaded: number) => void } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new UploadAborted());
      return;
    }
    const request = new XMLHttpRequest();
    const stop = () => request.abort();
    const settle = (finish: () => void) => {
      options.signal?.removeEventListener("abort", stop);
      finish();
    };
    request.open("PUT", `/api/ui/uploads/${encodeURIComponent(uploadId)}/parts/${index}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = (event: ProgressEvent) => options.onProgress?.(event.loaded);
    request.onload = () =>
      settle(() => {
        if (request.status >= 200 && request.status < 300) {
          resolve();
        } else {
          reject(new Error(refusalIn(request.responseText ?? "", `the file could not be attached (${request.status})`)));
        }
      });
    request.onerror = () => settle(() => reject(new Error("the connection was lost while the file was uploading")));
    request.ontimeout = () => settle(() => reject(new Error("the upload timed out; try again")));
    request.onabort = () => settle(() => reject(new UploadAborted()));
    options.signal?.addEventListener("abort", stop);
    request.send(part);
  });
}

/**
 * Throws away an upload the person changed their mind about. Best effort: the hub sweeps an upload no message ever
 * claimed, so a failed discard is not worth telling them about.
 */
export async function discardUpload(uploadId: string): Promise<void> {
  try {
    await fetch(`/api/ui/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
  } catch {
    return;
  }
}

export interface UploadRequest {
  conversationId: string;
  name: string;
  mediaType: string;
  body: Blob;
  signal?: AbortSignal;
  /** Called as soon as the upload exists, so it can be discarded even while its parts are still going. */
  onCreated?: (uploadId: string) => void;
  /** Bytes of the whole file that have left the browser. */
  onProgress?: (sent: number) => void;
}

/**
 * One file, start to finish, as the upload id a message can carry. Parts go one at a time and in order: the hub
 * counts on that, and sending them together would put four parts of the file in memory at once for no gain.
 */
export async function uploadFile(request: UploadRequest): Promise<string> {
  const created = await createUpload(
    { conversationId: request.conversationId, name: request.name, size: request.body.size, mediaType: request.mediaType },
    request.signal
  );
  request.onCreated?.(created.uploadId);
  const partBytes = created.partBytes > 0 ? created.partBytes : PART_BYTES;
  for (const range of partRanges(request.body.size, partBytes)) {
    await putPart(created.uploadId, range.index, request.body.slice(range.start, range.end), {
      signal: request.signal,
      onProgress: (loaded) => request.onProgress?.(range.start + loaded)
    });
    request.onProgress?.(range.end);
  }
  return created.uploadId;
}
