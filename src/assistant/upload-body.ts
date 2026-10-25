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
 * place. The reader below allocates exactly `maxBytes`, fills it, and refuses the moment a body runs past it, so one
 * part is the most any request can ever cost.
 */
export async function readBytes(request: Request, maxBytes: number): Promise<UploadBytes> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw tooLarge(maxBytes);
  }
  if (request.body === null) {
    return new Uint8Array(0);
  }
  const buffer = new Uint8Array(maxBytes);
  const reader = request.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return buffer.subarray(0, received);
    }
    if (received + value.byteLength > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    buffer.set(value, received);
    received += value.byteLength;
  }
}

function tooLarge(maxBytes: number): HttpError {
  return new HttpError(413, `this part of the file is larger than ${maxBytes} bytes`, { reason: "part_too_big" satisfies UploadRefusal });
}
