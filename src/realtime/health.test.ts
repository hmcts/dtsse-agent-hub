import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_INTERVAL_MS, HEALTH_TIMEOUT_MS, startHealthChecks } from "./health.ts";

describe("startHealthChecks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should query every interval and report nothing while the connection answers", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const onFailure = vi.fn();
    const stop = startHealthChecks({ client: { query }, onFailure });

    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(onFailure).not.toHaveBeenCalled();
    stop();
  });

  it("should report once and stop checking when the query fails, whatever it rejects with", async () => {
    const query = vi.fn(() => Promise.reject("terminating connection"));
    const onFailure = vi.fn();
    startHealthChecks({ client: { query }, onFailure, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(5000);

    expect(query).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("health check failed: terminating connection");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should report a failure when the query does not answer within the timeout", async () => {
    const onFailure = vi.fn();
    startHealthChecks({ client: { query: () => new Promise(() => undefined) }, onFailure });

    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS + HEALTH_TIMEOUT_MS - 1);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(onFailure).toHaveBeenCalledExactlyOnceWith(`health check failed: no answer within ${HEALTH_TIMEOUT_MS}ms`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should report only the first failure when slow checks overlap", async () => {
    const pending: ((error: unknown) => void)[] = [];
    const onFailure = vi.fn();
    startHealthChecks({
      client: { query: () => new Promise((_resolve, reject) => pending.push(reject)) },
      onFailure,
      intervalMs: 1000,
      timeoutMs: 60_000
    });
    await vi.advanceTimersByTimeAsync(2000);

    pending[0]?.(new Error("first"));
    pending[1]?.("second");
    await vi.advanceTimersByTimeAsync(0);

    expect(onFailure).toHaveBeenCalledExactlyOnceWith("health check failed: first");
  });

  it("should not report a failure that arrives after it was stopped", async () => {
    let reject: (error: unknown) => void = () => undefined;
    const onFailure = vi.fn();
    const stop = startHealthChecks({ client: { query: () => new Promise((_resolve, fail) => (reject = fail)) }, onFailure, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    stop();
    reject(new Error("connection ended"));
    await vi.advanceTimersByTimeAsync(0);

    expect(onFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
