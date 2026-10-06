import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The bearer a virtual agent's pod authenticates with. The hub mints one when the orchestrator claims an agent that
 * is starting, hands the plain token to the orchestrator once, and keeps only its SHA-256: a token is 32 random
 * bytes, so a fast hash is enough and a leaked database row cannot be replayed.
 */

export const LAUNCH_TOKEN_PREFIX = "ahv_";

const TOKEN_BYTES = 32;

/** The prefix and 32 bytes as unpadded base64url, which is 43 characters. */
const LAUNCH_TOKEN = /^ahv_[A-Za-z0-9_-]{43}$/;

export interface MintedToken {
  token: string;
  hash: Uint8Array<ArrayBuffer>;
}

export function hashLaunchToken(token: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash("sha256").update(token, "utf8").digest());
}

export function mintLaunchToken(random: (size: number) => Buffer = randomBytes): MintedToken {
  const token = `${LAUNCH_TOKEN_PREFIX}${random(TOKEN_BYTES).toString("base64url")}`;
  return { token, hash: hashLaunchToken(token) };
}

/** Whether a bearer is meant as a launch token rather than an Entra access token, which never starts this way. */
export function looksLikeLaunchToken(bearer: string): boolean {
  return bearer.startsWith(LAUNCH_TOKEN_PREFIX);
}

export function isWellFormedLaunchToken(token: string): boolean {
  return LAUNCH_TOKEN.test(token);
}

/** Whether `token` is the one `stored` is the hash of, compared in constant time. */
export function launchTokenMatches(token: string, stored: Uint8Array | null): boolean {
  if (stored === null || stored.length !== 32 || !isWellFormedLaunchToken(token)) {
    return false;
  }
  return timingSafeEqual(hashLaunchToken(token), stored);
}

const ANY_LAUNCH_TOKEN = /ahv_[A-Za-z0-9_-]+/g;

/** `text` with anything shaped like a launch token replaced, for an error that may quote the spec it was applying. */
export function withoutLaunchTokens(text: string): string {
  return text.replace(ANY_LAUNCH_TOKEN, `${LAUNCH_TOKEN_PREFIX}[redacted]`);
}
