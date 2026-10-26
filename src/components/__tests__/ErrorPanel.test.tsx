/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorPanel, errorDigest } from "@/components/ErrorPanel";
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
