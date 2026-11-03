// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewportFit } from "@/components/ViewportFit";

type Listener = () => void;

function fakeViewport(height: number, offsetTop = 0, scale = 1) {
  const listeners = new Map<string, Set<Listener>>();
  const viewport = {
    height,
    offsetTop,
    scale,
    addEventListener: (type: string, listener: Listener) => listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)),
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener)
  };
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  return {
    viewport,
    fire: (type: string) =>
      listeners.get(type)?.forEach((listener) => {
        listener();
      })
  };
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--app-height");
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  vi.restoreAllMocks();
});

describe("ViewportFit", () => {
  it("should set the app height to the visible height, and follow it as the keyboard opens", () => {
    const { viewport, fire } = fakeViewport(800);
    render(<ViewportFit />);
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("800px");

    viewport.height = 480;
    fire("resize");

    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("480px");
  });

  it("should put the page back at the top when the browser pans it to show a field", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const { viewport, fire } = fakeViewport(480);
    render(<ViewportFit />);
    scrollTo.mockClear();

    viewport.offsetTop = 120;
    fire("scroll");

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("should leave the height alone, and clear it on unmount", () => {
    fakeViewport(800);
    const { unmount } = render(<ViewportFit />);
    unmount();

    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
  });

  it("should leave the layout and the scroll alone while the person is pinch-zoomed", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const { viewport, fire } = fakeViewport(800);
    render(<ViewportFit />);
    scrollTo.mockClear();

    viewport.height = 400;
    viewport.scale = 2;
    viewport.offsetTop = 90;
    fire("resize");

    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("should do nothing in a browser without a visual viewport", () => {
    Object.defineProperty(window, "visualViewport", { value: null, configurable: true });
    render(<ViewportFit />);

    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
  });
});
