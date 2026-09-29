import { EncryptJWT, jwtDecrypt } from "jose";

/**
 * A small object in a cookie that the browser can neither read nor alter: `dir` with A256GCM hides and
 * authenticates in one pass, so a tampered cookie fails to decrypt.
 */

/**
 * A 256-bit key derived from the configured secret by SHA-256, so a secret of any length gives a key of the right
 * size without truncating or padding it. Web Crypto rather than `node:crypto`, because `src/proxy.ts` reads the
 * session and must not depend on Node-only APIs.
 */
async function key(secret: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(digest);
}

export async function seal(claims: Record<string, unknown>, secret: string, maxAgeSeconds: number, now = new Date()): Promise<string> {
  const issued = Math.floor(now.getTime() / 1000);
  return await new EncryptJWT(claims)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt(issued)
    .setExpirationTime(issued + maxAgeSeconds)
    .encrypt(await key(secret));
}

/** What a cookie carries, or `undefined` for every kind of failure: expired, tampered with, rotated secret, absent. */
export async function open(token: string | undefined, secret: string): Promise<Record<string, unknown> | undefined> {
  if (!token) {
    return undefined;
  }
  try {
    const { payload } = await jwtDecrypt(token, await key(secret));
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
