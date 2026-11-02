// When the bridge opens its next stream. A stream that ended cleanly is reopened at once unless they keep ending
// quickly; one that failed backs off exponentially.
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
// The service ends every stream within about 25s and the client reconnects at once. A stream that
// ends this soon after opening, this many times running, is a server that cannot hold one, so back off.
export const RAPID_CLOSE_MS = 2000;
export const RAPID_CLOSES_BEFORE_BACKOFF = 3;

export function nextBackoff(current: number): number {
  return Math.min(MAX_BACKOFF_MS, current ? current * 2 : MIN_BACKOFF_MS);
}

/** How the last stream ended, as `reconnectDelay` reads it. */
export type StreamEnd = {
  clean: boolean;
  lastedMs: number;
};

export type RetryState = {
  backoff?: number;
  rapidCloses?: number;
};

export type ReconnectDecision = {
  delay: number;
  backoff: number;
  rapidCloses: number;
};

// How long to wait before the next connection. `clean` is a stream that ended without an error,
// with or without a `reconnect` event; `lastedMs` is how long it was open.
export function reconnectDelay({ backoff = 0, rapidCloses = 0 }: RetryState = {}, { clean, lastedMs }: StreamEnd): ReconnectDecision {
  if (!clean) {
    const next = nextBackoff(lastedMs > 60000 ? 0 : backoff);
    return { delay: next, backoff: next, rapidCloses: 0 };
  }
  if (lastedMs >= RAPID_CLOSE_MS) {
    return { delay: 0, backoff: 0, rapidCloses: 0 };
  }
  const rapid = rapidCloses + 1;
  if (rapid < RAPID_CLOSES_BEFORE_BACKOFF) {
    return { delay: 0, backoff: 0, rapidCloses: rapid };
  }
  const next = nextBackoff(backoff);
  return { delay: next, backoff: next, rapidCloses: rapid };
}
