/** What a transcript upload may carry, and how much of each agent's transcript the hub keeps. */

export const MAX_BATCH_ENTRIES = 100;

/** An entry's `content` as JSON, in UTF-8 bytes. The client truncates anything longer and marks it `truncated`. */
export const MAX_ENTRY_CONTENT_BYTES = 16_384;

export const MAX_SESSION_ID = 200;
export const MAX_ENTRY_KEY = 200;
export const ENTRY_KEY_PATTERN = /^[A-Za-z0-9:_-]+$/;

/** A redacted entry's `redacted`: the source of the secret pattern it matched, as the client's scanner reports it. */
export const MAX_REDACTED_PATTERN = 1000;

/** Entries are deleted this long after they occurred. */
export const RETENTION_DAYS = 30;

/** Beyond this, an agent's oldest entries are deleted first. */
export const MAX_ENTRIES_PER_AGENT = 20_000;

/** The size `MAX_ENTRY_CONTENT_BYTES` is measured in. */
export function contentBytes(content: unknown): number {
  return new TextEncoder().encode(JSON.stringify(content)).byteLength;
}
