import { createHash } from "node:crypto";

/** Git's SHA-1 of a blob: of `blob <length>\0` and then the bytes, which is how a tree entry names a file. */
export function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex"); // NOSONAR: git's blob id is SHA-1; this checks a download against the listing, not authenticity
}
