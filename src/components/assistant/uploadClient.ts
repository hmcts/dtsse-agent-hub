"use client";

/**
 * The browser half of an attachment upload: what the person is allowed to attach, how a file is cut into parts, and
 * the three calls that carry it to the hub. Same-origin and authenticated by the `ah_session` cookie, so there is no
 * token to carry and nothing to configure.
 *
 * Parts go through `XMLHttpRequest` rather than `fetch`, because `fetch` reports no progress while a request body is
 * being sent in any shipping browser, and a 4 MiB part over VPN takes long enough that a person needs to see it move.
 *
 * Every cap here is imported from `src/assistant/uploads.ts`, which is the same module the routes enforce them from.
 * A second copy of 25 MB would be a client that refuses what the hub accepts, or accepts what the hub refuses, the
 * first time one of them moved.
 */

import { describeBytes, MAX_ATTACHMENTS_PER_MESSAGE, MAX_CONVERSATION_BYTES, MAX_UPLOAD_BYTES, type UploadRefusal } from "@/assistant/uploads";

export interface CreatedUpload {
  uploadId: string;
  partBytes: number;
  /** How many parts the hub expects, so the browser's own arithmetic can be checked against it before any are sent. */
  parts: number;
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
  if (attached + chosen.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { accepted: [], refusal: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to a message.` };
  }
  const tooBig = chosen.filter((file) => file.size > MAX_UPLOAD_BYTES);
  const empty = chosen.filter((file) => file.size === 0);
  const refusals: string[] = [];
  if (tooBig.length > 0) {
    refusals.push(
      `${listNames(tooBig.map((file) => file.name))} ${tooBig.length === 1 ? "is" : "are"} too big. Each file must be ${describeBytes(MAX_UPLOAD_BYTES)} or less.`
    );
  }
  if (empty.length > 0) {
    refusals.push(`${listNames(empty.map((file) => file.name))} ${empty.length === 1 ? "is" : "are"} empty, so there is nothing to attach.`);
  }
  return {
    accepted: chosen.filter((file) => file.size > 0 && file.size <= MAX_UPLOAD_BYTES),
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

/**
 * What to tell the person for each refusal the routes can give. The hub's own `error` is written for the API contract
 * and reads as a rule rather than as something that just happened to them; these are the same facts in the second
 * person, and they say what to do next.
 *
 * The two `409`s matter most. They are the same status and the same shape, but "you have four files on this message
 * already" is a nudge to send and carry on, and "this chat is full" means no further file will ever fit in it — so
 * they must not be told in the same words.
 */
const REFUSALS: Readonly<Record<UploadRefusal, string>> = {
  unavailable: "Attaching files is not switched on here yet.",
  no_such_conversation: "This chat no longer exists, so the file could not be attached.",
  no_such_upload: "This file is no longer being uploaded. Remove it and attach it again.",
  file_too_big: `This file is too big. Each file must be ${describeBytes(MAX_UPLOAD_BYTES)} or less.`,
  too_many_files: `This message already has ${MAX_ATTACHMENTS_PER_MESSAGE} files. Send it, then attach the rest to your next one.`,
  conversation_full: `This chat is full: its files can add up to ${describeBytes(MAX_CONVERSATION_BYTES)} in total. Start a new chat to attach more.`,
  part_too_big: "Part of the file was rejected as too large. Remove it and attach it again.",
  part_wrong_length: "The file changed while it was uploading. Remove it and attach it again."
};

function isRefusal(value: unknown): value is UploadRefusal {
  return typeof value === "string" && Object.hasOwn(REFUSALS, value);
}

/**
 * What to show for a refused request: this module's own sentence for a reason it knows, else the hub's own `error` —
 * never swallowed into something generic, because a refusal nothing here has wording for is still the truest thing
 * anyone can tell the person. The status sentence is the last resort, for a body that is not the hub's shape at all
 * (a gateway's HTML, say).
 */
export function refusalIn(body: string, fallback: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return fallback;
  }
  const reason = "reason" in parsed ? parsed.reason : undefined;
  if (isRefusal(reason)) {
    return REFUSALS[reason];
  }
  return "error" in parsed && typeof parsed.error === "string" ? parsed.error : fallback;
}

function isCreated(body: unknown): body is CreatedUpload {
  return (
    typeof body === "object" &&
    body !== null &&
    "uploadId" in body &&
    typeof body.uploadId === "string" &&
    "partBytes" in body &&
    typeof body.partBytes === "number" &&
    body.partBytes > 0 &&
    "parts" in body &&
    typeof body.parts === "number" &&
    body.parts > 0
  );
}

/**
 * Claims an upload, its size of part and its number of parts. The hub decides the stored name, so the one sent here is
 * only a request, and it answers `201` — `response.ok` rather than a status of its own, so a `200` would do as well.
 */
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("the hub did not say where to send the file");
  }
  if (!isCreated(parsed)) {
    throw new Error("the hub did not say where to send the file");
  }
  return { uploadId: parsed.uploadId, partBytes: parsed.partBytes, parts: parsed.parts };
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
 * Throws away an upload the person changed their mind about. The hub answers `204`; nothing here reads the status,
 * because this is best effort either way — the sweep expires an upload no message ever claimed, so a failed discard
 * is not worth telling them about.
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
 *
 * The hub's `parts` is checked against the ranges worked out here before anything is sent. It cannot replace them —
 * a part needs its `[start, end)` to slice the blob, which a count does not give — but a disagreement means the two
 * ends do not have the same file in mind, and the upload would otherwise sit `pending` for ever while the composer
 * showed it as finished.
 */
export async function uploadFile(request: UploadRequest): Promise<string> {
  const created = await createUpload(
    { conversationId: request.conversationId, name: request.name, size: request.body.size, mediaType: request.mediaType },
    request.signal
  );
  request.onCreated?.(created.uploadId);
  const ranges = partRanges(request.body.size, created.partBytes);
  if (ranges.length !== created.parts) {
    throw new Error("the hub expects this file in a different number of pieces; remove it and attach it again");
  }
  for (const range of ranges) {
    await putPart(created.uploadId, range.index, request.body.slice(range.start, range.end), {
      signal: request.signal,
      onProgress: (loaded) => request.onProgress?.(range.start + loaded)
    });
    request.onProgress?.(range.end);
  }
  return created.uploadId;
}
