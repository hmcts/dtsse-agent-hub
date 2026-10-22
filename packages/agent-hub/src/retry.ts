// Exponential-backoff retry. This module imports nothing: the decision about which failures are worth another
// attempt is the caller's, passed in as `retryable`.

export type RetryOptions = {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  wait?: (ms: number) => Promise<void>;
  retryable?: (error: unknown) => boolean;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Anything carrying a numeric `status` came from an HTTP response, and only a rate limit or a server fault is
// worth repeating. Everything else — a socket reset, a DNS failure, a thrown `Error` — gets another attempt.
export function retryableByStatus(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== "number") {
    return true;
  }
  return status === 429 || status >= 500;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 6, baseMs = 1000, maxMs = 30000, wait = sleep, retryable = retryableByStatus }: RetryOptions = {}
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !retryable(e)) {
        throw e;
      }
      await wait(Math.min(maxMs, baseMs * 2 ** (i - 1)));
    }
  }
}
