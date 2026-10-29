/**
 * How long a wait for something the suite expects to happen gives up after.
 *
 * Every use of it is a deadline rather than a delay — the waiter returns as soon as what it is waiting for arrives —
 * so this only sets how patient a *failing* wait is, and a generous value costs a passing run nothing. Generous
 * because the suite's files run in parallel: a NOTIFY or a sweep on a machine running six workers, and whatever else
 * shares its Postgres, can be slow without anything being wrong. 5s was enough when one file ran at a time.
 *
 * A test asserting that something never happens passes its own short timeout instead, and must: waiting this long to
 * conclude nothing arrived would make the suite slower for no added confidence.
 */
export const WAIT_MS = 15_000;

/**
 * Waits until `check` holds, which is how a test watches something a timer drives — a sweeper's ticks, a log it
 * writes — without a sleep long enough to be safe on a loaded agent and slow on every passing run.
 */
export async function until(check: () => boolean, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the sweeper");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
