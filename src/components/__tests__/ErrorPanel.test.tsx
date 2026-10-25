/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorPanel, errorDigest } from "@/components/ErrorPanel";
import { type ConnectivityDependencies, createRetryBudget } from "@/components/error-recovery";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function serverError(message: string, digest: unknown): Error {
  return Object.assign(new Error(message), { digest });
}

/**
 * A browser the test moves. `online` stays true unless a test says otherwise, because that is what a VPN flap
 * looks like: the interface changed, the machine still has a network.
 */
function fakeConnectivity(online = true): ConnectivityDependencies & { reconnect: () => void } {
  const handlers = new Set<() => void>();
  return {
    online: () => online,
    watch: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    reconnect: () => {
      online = true;
      for (const handler of [...handlers]) {
        handler();
      }
    }
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("ErrorPanel", () => {
  it("should show the digest and never the message when a server component threw", () => {
    render(
      <ErrorPanel
        error={serverError('relation "agent" does not exist at db.internal:5432', "4096281734")}
        retry={vi.fn()}
        connectivity={fakeConnectivity()}
        budget={createRetryBudget()}
      />
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    expect(screen.getByRole("alert").textContent).toContain("4096281734");
    expect(document.body.textContent).not.toContain("relation");
    expect(document.body.textContent).not.toContain("db.internal");
  });

  it("should leave out the reference line when the error has no digest", () => {
    render(<ErrorPanel error={new Error("thrown in the browser")} retry={vi.fn()} connectivity={fakeConnectivity()} budget={createRetryBudget()} />);

    expect(screen.getByRole("alert").textContent).not.toContain("reference");
    expect(document.body.textContent).not.toContain("thrown in the browser");
  });

  it("should retry the segment when the viewer presses try again", () => {
    const retry = vi.fn();
    render(<ErrorPanel error={undefined} retry={retry} connectivity={fakeConnectivity()} budget={createRetryBudget()} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("should link home with a full page load when the viewer gives up", () => {
    render(<ErrorPanel error={undefined} retry={vi.fn()} connectivity={fakeConnectivity()} budget={createRetryBudget()} />);

    expect(screen.getByRole("link", { name: "Back to home" }).getAttribute("href")).toBe("/");
  });

  it("should retry on its own while the browser still reports a network, as it does through a flap", async () => {
    const retry = vi.fn();
    render(<ErrorPanel error={undefined} retry={retry} connectivity={fakeConnectivity(true)} budget={createRetryBudget()} />);
    expect(screen.getByRole("alert").textContent).toContain("Trying again automatically");

    await advance(999);
    expect(retry).not.toHaveBeenCalled();

    await advance(1);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("should retry as soon as the network comes back when the browser has none", async () => {
    const retry = vi.fn();
    const connectivity = fakeConnectivity(false);
    render(<ErrorPanel error={undefined} retry={retry} connectivity={connectivity} budget={createRetryBudget()} />);
    expect(screen.getByRole("alert").textContent).toContain("not connected to the internet");

    await act(async () => {
      connectivity.reconnect();
    });
    expect(retry).toHaveBeenCalledTimes(1);

    await advance(10_000);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("should wait longer before each attempt and then stop, leaving the button, when the failure keeps happening", async () => {
    const retry = vi.fn();
    const budget = createRetryBudget();
    const panel = () => <ErrorPanel error={undefined} retry={retry} connectivity={fakeConnectivity()} budget={budget} />;

    // Each failed retry remounts the panel, which is why the budget cannot live in the component.
    for (const delay of [1_000, 3_000, 9_000]) {
      const { unmount } = render(panel());
      await advance(delay);
      unmount();
    }
    expect(retry).toHaveBeenCalledTimes(3);

    render(panel());
    await advance(60_000);

    expect(retry).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("alert").textContent).toContain("so try again");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("should not retry after the boundary has gone when an attempt was due", async () => {
    const retry = vi.fn();
    const { unmount } = render(<ErrorPanel error={undefined} retry={retry} connectivity={fakeConnectivity()} budget={createRetryBudget()} />);

    unmount();
    await advance(60_000);

    expect(retry).not.toHaveBeenCalled();
  });

  it("should fall back to the shared budget and the browser's own network when given neither", () => {
    render(<ErrorPanel error={undefined} retry={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
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
