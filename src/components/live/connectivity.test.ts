/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserConnectivity, type ConnectivityDependencies, whenOnline } from "./connectivity.ts";

/** A browser whose network the test moves: `restore()` sends the `online` event to whoever is watching. */
function fakeConnectivity(online: boolean): ConnectivityDependencies & { restore: () => void; watching: () => number } {
  const handlers = new Set<() => void>();
  return {
    online: () => online,
    watch: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    restore: () => {
      online = true;
      for (const handler of [...handlers]) {
        handler();
      }
    },
    watching: () => handlers.size
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whenOnline", () => {
  it("should run the work and wait for nothing when the browser has a network", () => {
    const connectivity = fakeConnectivity(true);
    const run = vi.fn();

    expect(whenOnline(run, connectivity)).toBeNull();

    expect(run).toHaveBeenCalledTimes(1);
    expect(connectivity.watching()).toBe(0);
  });

  it("should hold the work until the network returns when the browser has none", () => {
    const connectivity = fakeConnectivity(false);
    const run = vi.fn();

    expect(whenOnline(run, connectivity)).toBeTypeOf("function");
    expect(run).not.toHaveBeenCalled();

    connectivity.restore();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("should run the work once and stop watching when the network returns more than once", () => {
    const connectivity = fakeConnectivity(false);
    const run = vi.fn();
    whenOnline(run, connectivity);

    connectivity.restore();
    connectivity.restore();

    expect(run).toHaveBeenCalledTimes(1);
    expect(connectivity.watching()).toBe(0);
  });

  it("should never run the work when the waiting run is cancelled first", () => {
    const connectivity = fakeConnectivity(false);
    const run = vi.fn();
    const cancel = whenOnline(run, connectivity);

    cancel?.();
    cancel?.();
    connectivity.restore();

    expect(run).not.toHaveBeenCalled();
    expect(connectivity.watching()).toBe(0);
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
