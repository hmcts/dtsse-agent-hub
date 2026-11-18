import { HttpError } from "../agent-api/http.ts";
import type { UploadBytes } from "./upload-store.ts";
import type { UploadRefusal } from "./uploads.ts";

/**
 * The one request body in the service that is read as bytes rather than text.
 *
 * `readJson`/`readText` in `src/agent-api/http.ts` cap a body at `MAX_REQUEST_BYTES` (256 KiB), which is right for
 * every other route and far below one upload part, so an upload part is read here instead.
 *
 * **Never `await request.arrayBuffer()`.** That buffers whatever the client chose to send, so a 25 MB file would be a
 * 25 MB allocation on a 768 MB heap shared by two replicas — the whole reason the file is sent in parts in the first
 * place. The reader below never holds more than `maxBytes`, and refuses the moment a body runs past it, so one part
 * is the most any request can ever cost.
 *
 * Its buffer starts at the declared length, which is under the cap once it passes the check, or at
 * `INITIAL_BYTES` when there is none, and grows by doubling as the body arrives, so a small body under a large cap
 * (a pod job's answer, read up to 1 MiB) costs about its own size. A length that understates the body only means a
 * copy as it grows.
 */
export async function readBytes(request: Request, maxBytes: number): Promise<UploadBytes> {
  const declared = request.headers.get("content-length");
  const length = declared === null || declared.trim() === "" ? Number.NaN : Number(declared);
  if (length > maxBytes) {
    throw tooLarge(maxBytes);
  }
  if (request.body === null) {
    return new Uint8Array(0);
  }
  let buffer = new Uint8Array(Number.isSafeInteger(length) && length >= 0 ? length : Math.min(maxBytes, INITIAL_BYTES));
  const reader = request.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return buffer.subarray(0, received);
    }
    const needed = received + value.byteLength;
    if (needed > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    if (needed > buffer.byteLength) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(needed, buffer.byteLength * 2)));
      grown.set(buffer.subarray(0, received));
      buffer = grown;
    }
    buffer.set(value, received);
    received = needed;
  }
}

/** Where a body with no declared length starts. */
const INITIAL_BYTES = 64 * 1024;

function tooLarge(maxBytes: number): HttpError {
  return new HttpError(413, `this part of the file is larger than ${maxBytes} bytes`, { reason: "part_too_big" satisfies UploadRefusal });
}
