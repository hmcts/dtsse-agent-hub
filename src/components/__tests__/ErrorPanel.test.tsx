/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserReconnect, ErrorPanel, errorDigest, isNetworkFailure, RECONNECT_WINDOW_MS, type ReconnectDependencies } from "@/components/ErrorPanel";
import type { ConnectivityDependencies } from "@/components/live/connectivity";

afterEach(cleanup);

function serverError(message: string, digest: unknown): Error {
  return Object.assign(new Error(message), { digest });
}

/** A browser with no network until `restore()` gives it one and tells whoever is watching. */
function offlineConnectivity(): ConnectivityDependencies & { restore: () => Promise<void> } {
  const handlers = new Set<() => void>();
  let online = false;
  return {
    online: () => online,
    watch: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    restore: async () => {
      online = true;
      await act(async () => {
        for (const handler of [...handlers]) {
          handler();
        }
      });
    }
  };
}

/**
 * A clock the test moves by hand. `elapse()` runs whichever retry is waiting, `wake()` stands for the network
 * coming back or the tab being shown, and the ledger is shared by every panel the same fake is given, the way the
 * browser's is shared by every panel a failing page mounts.
 */
function fakeReconnect(): ReconnectDependencies & {
  waiting: () => number[];
  elapse: () => Promise<void>;
  wake: ReconnectDependencies["wake"] & { fire: () => Promise<void>; listening: () => number };
  advance: (ms: number) => void;
} {
  let time = 0;
  const timers = new Map<number, { ms: number; run: () => void }>();
  let next = 0;
  const wakers = new Set<() => void>();
  const wake = Object.assign(
    (handler: () => void) => {
      wakers.add(handler);
      return () => {
        wakers.delete(handler);
      };
    },
    {
      fire: async () => {
        await act(async () => {
          for (const handler of [...wakers]) {
            handler();
          }
        });
      },
      listening: () => wakers.size
    }
  );
  return {
    after: (ms, run) => {
      const id = next++;
      timers.set(id, { ms, run });
      return () => {
        timers.delete(id);
      };
    },
    now: () => time,
    page: () => "/assistant/c-1",
    wake,
    ledger: { current: null },
    waiting: () => [...timers.values()].map((timer) => timer.ms),
    elapse: async () => {
      const [entry] = [...timers.entries()];
      if (entry === undefined) {
        throw new Error("no retry is waiting");
      }
      const [id, timer] = entry;
      timers.delete(id);
      time += timer.ms;
      await act(async () => {
        timer.run();
      });
    },
    advance: (ms) => {
      time += ms;
    }
  };
}

/** What Chrome's fetch rejects with when the body is cut mid-stream, as with `ERR_NETWORK_CHANGED`. */
function cutMidStream(): TypeError {
  return new TypeError("network error");
}

describe("ErrorPanel", () => {
  it("should show the digest and never the message when a server component threw", () => {
    render(<ErrorPanel error={serverError('relation "agent" does not exist at db.internal:5432', "4096281734")} retry={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    expect(screen.getByRole("alert").textContent).toContain("4096281734");
    expect(document.body.textContent).not.toContain("relation");
    expect(document.body.textContent).not.toContain("db.internal");
  });

  it("should leave out the reference line when the error has no digest", () => {
    render(<ErrorPanel error={new Error("thrown in the browser")} retry={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).not.toContain("reference");
    expect(document.body.textContent).not.toContain("thrown in the browser");
  });

  it("should retry the segment when the viewer presses try again", () => {
    const retry = vi.fn();
    render(<ErrorPanel error={undefined} retry={retry} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("should link home with a full page load when the viewer gives up", () => {
    render(<ErrorPanel error={undefined} retry={vi.fn()} />);

    expect(screen.getByRole("link", { name: "Back to home" }).getAttribute("href")).toBe("/");
  });

  it("should say the network is down and offer no button or reference when the browser is offline", () => {
    render(<ErrorPanel error={serverError("boom", "4096281734")} retry={vi.fn()} connectivity={offlineConnectivity()} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("No internet connection");
    expect(screen.getByRole("alert").textContent).toContain("not connected to the internet");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(document.body.textContent).not.toContain("4096281734");
    expect(screen.getByRole("link", { name: "Back to home" })).toBeTruthy();
  });

  it("should retry on its own and offer the button again when the network returns", async () => {
    const retry = vi.fn();
    const connectivity = offlineConnectivity();
    render(<ErrorPanel error={undefined} retry={retry} connectivity={connectivity} />);
    expect(retry).not.toHaveBeenCalled();

    await connectivity.restore();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("should retry once and never watch when the network returns between the render and the effect", async () => {
    const retry = vi.fn();
    const connectivity = offlineConnectivity();
    const online = vi.spyOn(connectivity, "online").mockReturnValueOnce(false).mockReturnValue(true);
    const watch = vi.spyOn(connectivity, "watch");

    await act(async () => {
      render(<ErrorPanel error={undefined} retry={retry} connectivity={connectivity} />);
    });

    expect(online).toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("errorDigest", () => {
  it("should read the digest when it is a non-empty string", () => {
    expect(errorDigest(serverError("x", "123"))).toBe("123");
  });

  it("should give nothing when the thrown value is not an object carrying a string digest", () => {
    expect(errorDigest(undefined)).toBeUndefined();
    expect(errorDigest(null)).toBeUndefined();
    expect(errorDigest("a string")).toBeUndefined();
    expect(errorDigest(new Error("x"))).toBeUndefined();
    expect(errorDigest(serverError("x", 42))).toBeUndefined();
    expect(errorDigest(serverError("x", ""))).toBeUndefined();
  });
});

/**
 * A page that fails every time it loads, as Next's boundary does it: `retry` resets the boundary, which unmounts
 * the panel, and the segment throwing again mounts a fresh one with none of the last one's state.
 */
function brokenPage(error: unknown, reconnect: ReconnectDependencies): { retries: () => number } {
  let retries = 0;
  let mounted = render(<ErrorPanel error={error} retry={retry} reconnect={reconnect} />);
  function retry(): void {
    retries++;
    mounted.unmount();
    mounted = render(<ErrorPanel error={error} retry={retry} reconnect={reconnect} />);
  }
  return { retries: () => retries };
}

describe("ErrorPanel after a network failure the browser did not notice", () => {
  it("should retry on its own after a second while keeping the message and the button", async () => {
    const retry = vi.fn();
    const reconnect = fakeReconnect();
    render(<ErrorPanel error={cutMidStream()} retry={retry} reconnect={reconnect} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    expect(screen.getByRole("alert").textContent).toContain("Reconnecting…");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(reconnect.waiting()).toEqual([1_000]);

    await reconnect.elapse();

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("should back off and then stop, behaving as for any other error, when every retry fails", async () => {
    const reconnect = fakeReconnect();
    const page = brokenPage(cutMidStream(), reconnect);

    await reconnect.elapse();
    expect(reconnect.waiting()).toEqual([3_000]);
    await reconnect.elapse();

    expect(page.retries()).toBe(2);
    expect(reconnect.waiting()).toEqual([]);
    expect(screen.getByRole("alert").textContent).not.toContain("Reconnecting…");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("should start the attempts again when the page fails long after the last automatic retry", async () => {
    const reconnect = fakeReconnect();
    brokenPage(cutMidStream(), reconnect);
    await reconnect.elapse();
    await reconnect.elapse();
    cleanup();

    reconnect.advance(RECONNECT_WINDOW_MS);
    render(<ErrorPanel error={cutMidStream()} retry={vi.fn()} reconnect={reconnect} />);

    expect(reconnect.waiting()).toEqual([1_000]);
  });

  it("should give another page attempts of its own", async () => {
    const reconnect = fakeReconnect();
    brokenPage(cutMidStream(), reconnect);
    await reconnect.elapse();
    await reconnect.elapse();
    cleanup();

    render(<ErrorPanel error={cutMidStream()} retry={vi.fn()} reconnect={{ ...reconnect, page: () => "/assistant/c-2" }} />);

    expect(reconnect.waiting()).toEqual([1_000]);
  });

  it("should retry at once and drop the waiting retry when the network comes back or the tab is shown", async () => {
    const retry = vi.fn();
    const reconnect = fakeReconnect();
    render(<ErrorPanel error={cutMidStream()} retry={retry} reconnect={reconnect} />);

    await reconnect.wake.fire();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(reconnect.waiting()).toEqual([]);
  });

  it("should still retry when the network comes back after the attempts are spent", async () => {
    const reconnect = fakeReconnect();
    const page = brokenPage(cutMidStream(), reconnect);
    await reconnect.elapse();
    await reconnect.elapse();

    await reconnect.wake.fire();

    expect(page.retries()).toBe(3);
  });

  it("should stop waiting and listening when it unmounts", () => {
    const reconnect = fakeReconnect();
    const { unmount } = render(<ErrorPanel error={cutMidStream()} retry={vi.fn()} reconnect={reconnect} />);

    unmount();

    expect(reconnect.waiting()).toEqual([]);
    expect(reconnect.wake.listening()).toBe(0);
  });

  it("should never retry on its own when a server component threw", () => {
    const reconnect = fakeReconnect();
    render(<ErrorPanel error={Object.assign(cutMidStream(), { digest: "4096281734" })} retry={vi.fn()} reconnect={reconnect} />);

    expect(reconnect.waiting()).toEqual([]);
    expect(reconnect.wake.listening()).toBe(0);
    expect(screen.getByRole("alert").textContent).not.toContain("Reconnecting…");
  });

  it("should never retry on its own when the browser threw something other than a network failure", () => {
    const reconnect = fakeReconnect();
    render(<ErrorPanel error={new TypeError("Cannot read properties of undefined")} retry={vi.fn()} reconnect={reconnect} />);

    expect(reconnect.waiting()).toEqual([]);
    expect(reconnect.wake.listening()).toBe(0);
  });

  it("should leave the retry to the network's return when the browser was offline", async () => {
    const retry = vi.fn();
    const reconnect = fakeReconnect();
    const connectivity = offlineConnectivity();
    render(<ErrorPanel error={cutMidStream()} retry={retry} connectivity={connectivity} reconnect={reconnect} />);

    await connectivity.restore();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(reconnect.waiting()).toEqual([]);
    expect(screen.getByRole("alert").textContent).not.toContain("Reconnecting…");
  });
});

describe("isNetworkFailure", () => {
  it("should recognise each browser's network-failure TypeError", () => {
    for (const message of ["network error", "Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      expect(isNetworkFailure(new TypeError(message))).toBe(true);
    }
  });

  it("should recognise Flight's closed connection in the development and production builds", () => {
    expect(isNetworkFailure(new Error("Connection closed."))).toBe(true);
    expect(
      isNetworkFailure(
        new Error(
          "Minified React error #412; visit https://react.dev/errors/412 for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
        )
      )
    ).toBe(true);
  });

  it("should recognise a network failure that something wrapped as its cause", () => {
    expect(isNetworkFailure(new Error("render failed", { cause: new Error("outer", { cause: cutMidStream() }) }))).toBe(true);
  });

  it("should not recognise a network failure when a server error carries a digest", () => {
    expect(isNetworkFailure(Object.assign(new Error("Connection closed."), { digest: "4096281734" }))).toBe(false);
  });

  it("should not recognise a browser's network message on an error that is not a TypeError", () => {
    expect(isNetworkFailure(new Error("Failed to fetch"))).toBe(false);
  });

  it("should not recognise anything else, nor loop when a cause chain is circular", () => {
    const circular = new Error("a");
    circular.cause = circular;

    expect(isNetworkFailure(circular)).toBe(false);
    expect(isNetworkFailure(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isNetworkFailure("network error")).toBe(false);
    expect(isNetworkFailure(undefined)).toBe(false);
  });
});

describe("browserReconnect", () => {
  it("should run after the delay unless cancelled", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const cancelled = vi.fn();
      const reconnect = browserReconnect();
      reconnect.after(1_000, run);
      reconnect.after(1_000, cancelled)();

      vi.advanceTimersByTime(1_000);

      expect(run).toHaveBeenCalledTimes(1);
      expect(cancelled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should name the page by its path and query, and share one ledger between panels", () => {
    window.history.replaceState(null, "", "/assistant/c-1?settings=model");

    expect(browserReconnect().page()).toBe("/assistant/c-1?settings=model");
    expect(browserReconnect().ledger).toBe(browserReconnect().ledger);
    expect(browserReconnect().now()).toBeGreaterThan(0);
  });

  it("should wake on the online event and on the tab being shown, never hidden, until told to stop", () => {
    const handler = vi.fn();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    try {
      const stop = browserReconnect().wake(handler);

      window.dispatchEvent(new Event("online"));
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(handler).toHaveBeenCalledTimes(2);

      stop();
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));

      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
    }
  });
});
