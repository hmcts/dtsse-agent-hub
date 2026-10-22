import { describe, expect, it } from "vitest";
import { retryableByStatus, withRetry } from "./retry.ts";

function recorder() {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => void waits.push(ms) };
}

describe("withRetry", () => {
  it("should return the value when the call succeeds first time", async () => {
    const { waits, wait } = recorder();
    await expect(withRetry(async () => "ok", { wait })).resolves.toBe("ok");
    expect(waits).toEqual([]);
  });

  it("should retry until the call succeeds when the failure is retryable", async () => {
    const { waits, wait } = recorder();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new Error("flaky");
        }
        return calls;
      },
      { wait }
    );
    expect(result).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("should back off exponentially up to maxMs when it keeps failing", async () => {
    const { waits, wait } = recorder();
    await expect(
      withRetry(
        async () => {
          throw new Error("down");
        },
        { attempts: 6, baseMs: 1000, maxMs: 4000, wait }
      )
    ).rejects.toThrow("down");
    expect(waits).toEqual([1000, 2000, 4000, 4000, 4000]);
  });

  it("should throw the last error after the final attempt", async () => {
    const { waits, wait } = recorder();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`attempt ${calls}`);
        },
        { attempts: 2, wait }
      )
    ).rejects.toThrow("attempt 2");
    expect(calls).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it("should not retry when the caller's predicate rejects the error", async () => {
    const { waits, wait } = recorder();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("fatal");
        },
        { wait, retryable: () => false }
      )
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("should sleep for real when no wait is injected", async () => {
    let calls = 0;
    const started = Date.now();
    await withRetry(
      async () => {
        calls++;
        if (calls < 2) {
          throw new Error("once");
        }
        return calls;
      },
      { baseMs: 5 }
    );
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("retryableByStatus", () => {
  it("should retry when the error carries no HTTP status", () => {
    expect(retryableByStatus(new Error("ECONNRESET"))).toBe(true);
    expect(retryableByStatus(null)).toBe(true);
    expect(retryableByStatus(undefined)).toBe(true);
    expect(retryableByStatus({ status: "500" })).toBe(true);
  });

  it("should retry when the hub answered 429 or a server fault", () => {
    expect(retryableByStatus({ status: 429 })).toBe(true);
    expect(retryableByStatus({ status: 500 })).toBe(true);
    expect(retryableByStatus({ status: 503 })).toBe(true);
  });

  it("should not retry when the hub answered a client error it will answer the same way again", () => {
    expect(retryableByStatus({ status: 400 })).toBe(false);
    expect(retryableByStatus({ status: 403 })).toBe(false);
    expect(retryableByStatus({ status: 404 })).toBe(false);
    expect(retryableByStatus({ status: 409 })).toBe(false);
  });
});
