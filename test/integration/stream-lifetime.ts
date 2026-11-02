import type * as sse from "../../src/realtime/sse.ts";

/**
 * The lifetime a test gives the streams it opens, in milliseconds, or `undefined` for the one `openSseStream` works
 * out from `STREAM_MAX_SECONDS`. That setting has a floor of `MIN_STREAM_MAX_SECONDS`, which is right for a server and
 * is seconds of waiting for a test about what happens at the end, so the tests that wait for the end set this instead.
 */
export const streamLifetime: { ms: number | undefined } = { ms: undefined };

/** Long enough for a stream to open and deliver before it ends, and short enough not to be the test's cost. */
export const SHORT_LIFETIME_MS = 1_000;

/** `sse.ts` with `openSseStream` taking `streamLifetime.ms` as its lifetime whenever a test has set one. */
export function withStreamLifetime(actual: typeof sse): typeof sse {
  return {
    ...actual,
    openSseStream: (options) => actual.openSseStream(streamLifetime.ms === undefined ? options : { ...options, maxLifetimeMs: streamLifetime.ms })
  };
}
