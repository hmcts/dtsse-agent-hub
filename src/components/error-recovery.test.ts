/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserConnectivity, createRetryBudget, nextRetryDelay, recoveryMessage } from "@/components/error-recovery";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nextRetryDelay", () => {
  it("should back off further with each attempt already made", () => {
    expect(nextRetryDelay([], 0)).toBe(1_000);
    expect(nextRetryDelay([0], 0)).toBe(3_000);
    expect(nextRetryDelay([0, 0], 0)).toBe(9_000);
  });

  it("should give nothing when the attempts have all been made", () => {
    expect(nextRetryDelay([0, 0, 0], 0)).toBeNull();
    expect(nextRetryDelay([0, 0, 0, 0], 0)).toBeNull();
  });

  it("should forget attempts older than the window so a later failure retries again", () => {
    expect(nextRetryDelay([0, 0, 0], 59_999)).toBeNull();
    expect(nextRetryDelay([0, 0, 0], 60_000)).toBe(1_000);
    expect(nextRetryDelay([0, 0, 59_000], 60_000)).toBe(3_000);
  });
});

describe("createRetryBudget", () => {
  it("should hand out longer delays as it is spent and then nothing", () => {
    const budget = createRetryBudget(() => 0);

    expect(budget.delay()).toBe(1_000);
    budget.spend();
    expect(budget.delay()).toBe(3_000);
    budget.spend();
    expect(budget.delay()).toBe(9_000);
    budget.spend();

    expect(budget.delay()).toBeNull();
  });

  it("should refill once the window has passed since the attempts", () => {
    let now = 0;
    const budget = createRetryBudget(() => now);
    budget.spend();
    budget.spend();
    budget.spend();
    expect(budget.delay()).toBeNull();

    now = 60_000;

    expect(budget.delay()).toBe(1_000);
  });

  it("should keep an attempt inside the window when a later one lands", () => {
    let now = 0;
    const budget = createRetryBudget(() => now);
    budget.spend();

    now = 30_000;
    budget.spend();

    expect(budget.delay()).toBe(9_000);
  });
});

describe("recoveryMessage", () => {
  it("should tell the viewer to try again themselves when no attempt is coming", () => {
    expect(recoveryMessage(false, false)).toBe("This page could not be loaded. It is often a passing problem, so try again.");
    expect(recoveryMessage(true, false)).toBe("This page could not be loaded. It is often a passing problem, so try again.");
  });

  it("should promise an attempt, and name the network when there is none, while one is coming", () => {
    expect(recoveryMessage(false, true)).toBe("This page could not be loaded. Trying again automatically.");
    expect(recoveryMessage(true, true)).toContain("not connected to the internet");
  });

  it("should always be a whole sentence about the page and nothing about the error", () => {
    for (const offline of [true, false]) {
      for (const retrying of [true, false]) {
        expect(recoveryMessage(offline, retrying)).toMatch(/^This page could not be loaded.*\.$/);
      }
    }
  });
});

describe("browserConnectivity", () => {
  it("should read the browser as online when it reports a network", () => {
    vi.stubGlobal("navigator", { onLine: true });

    expect(browserConnectivity().online()).toBe(true);
  });

  it("should read the browser as offline when it reports no network", () => {
    vi.stubGlobal("navigator", { onLine: false });

    expect(browserConnectivity().online()).toBe(false);
  });

  it("should read the browser as online when there is no navigator to ask, as on the server", () => {
    vi.stubGlobal("navigator", undefined);

    expect(browserConnectivity().online()).toBe(true);
  });

  it("should call the handler on the window's online event until it is told to stop", () => {
    const handler = vi.fn();
    const unwatch = browserConnectivity().watch(handler);

    window.dispatchEvent(new Event("online"));
    expect(handler).toHaveBeenCalledTimes(1);

    unwatch();
    window.dispatchEvent(new Event("online"));

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
