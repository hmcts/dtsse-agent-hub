/**
 * A periodic `SELECT 1` on a connection that otherwise only listens. Such a connection sends nothing, so one whose
 * server has stopped answering (a failover, a socket a NAT dropped without a reset that keepalive has not caught yet)
 * would look healthy until the next write, which may never come.
 */

export const HEALTH_INTERVAL_MS = 30_000;
export const HEALTH_TIMEOUT_MS = 10_000;

export interface Queryable {
  query: (sql: string) => Promise<unknown>;
}

export interface HealthCheckOptions {
  client: Queryable;
  /** Called at most once, with why the check failed. The checks have stopped by then. */
  onFailure: (reason: string) => void;
  intervalMs?: number;
  timeoutMs?: number;
}

/** Returns the function that stops the checks. */
export function startHealthChecks({ client, onFailure, intervalMs = HEALTH_INTERVAL_MS, timeoutMs = HEALTH_TIMEOUT_MS }: HealthCheckOptions): () => void {
  let stopped = false;

  function stop(): void {
    stopped = true;
    clearInterval(interval);
  }

  async function check(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.query("SELECT 1"),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    } catch (error) {
      if (!stopped) {
        stop();
        onFailure(`health check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const interval = setInterval(() => void check(), intervalMs);
  interval.unref();
  return stop;
}
