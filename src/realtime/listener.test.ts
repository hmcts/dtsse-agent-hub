import { describe, expect, it } from "vitest";
import { backoffDelay } from "./listener.ts";

describe("backoffDelay", () => {
  it("should never wait less than the minimum, even when the jitter draws zero", () => {
    expect(backoffDelay(0, 500, 30_000, () => 0)).toBe(500);
  });

  it("should double the ceiling with each failed attempt", () => {
    expect(backoffDelay(1, 500, 30_000, () => 0.5)).toBe(500);
    expect(backoffDelay(3, 500, 30_000, () => 0.5)).toBe(2000);
  });

  it("should cap the wait at the maximum however many attempts have failed", () => {
    expect(backoffDelay(50, 500, 30_000, () => 0.999_999)).toBeLessThanOrEqual(30_000);
    expect(backoffDelay(50, 500, 30_000, () => 0.999_999)).toBeGreaterThan(29_000);
  });
});
