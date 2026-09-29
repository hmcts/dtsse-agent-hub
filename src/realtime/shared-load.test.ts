import { describe, expect, it, vi } from "vitest";
import { sharedLoads } from "./shared-load.ts";

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    }
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("sharedLoads", () => {
  it("should load once for every caller when they ask while the load is in flight", async () => {
    const load = vi.fn(async (key: number) => `value ${key}`);
    const get = sharedLoads(load, { ttlMs: 1000, now: clock().now });

    const values = await Promise.all([get(1), get(1), get(1)]);

    expect(values).toEqual(["value 1", "value 1", "value 1"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("should reuse a resolved load when asked again within the TTL", async () => {
    const time = clock();
    const load = vi.fn(async (key: number) => `value ${key}`);
    const get = sharedLoads(load, { ttlMs: 1000, now: time.now });

    await get(1);
    time.advance(999);
    await get(1);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("should load again when the TTL has passed", async () => {
    const time = clock();
    const load = vi.fn(async (key: number) => `value ${key}`);
    const get = sharedLoads(load, { ttlMs: 1000, now: time.now });

    await get(1);
    await settle();
    time.advance(1000);
    await get(1);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("should load each key separately when different keys are asked for", async () => {
    const load = vi.fn(async (key: bigint) => `value ${key}`);
    const get = sharedLoads(load, { ttlMs: 1000, now: clock().now });

    expect(await Promise.all([get(1n), get(2n), get(1n)])).toEqual(["value 1", "value 2", "value 1"]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("should retry on the next call when a load fails", async () => {
    const load = vi.fn<(key: number) => Promise<string>>().mockRejectedValueOnce(new Error("database gone")).mockResolvedValueOnce("value 1");
    const get = sharedLoads(load, { ttlMs: 1000, now: clock().now });

    await expect(get(1)).rejects.toThrow("database gone");
    await settle();

    expect(await get(1)).toBe("value 1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("should use the real clock when none is given", async () => {
    const load = vi.fn(async (key: number) => `value ${key}`);
    const get = sharedLoads(load, { ttlMs: 60_000 });

    await get(1);
    await get(1);

    expect(load).toHaveBeenCalledTimes(1);
  });
});
