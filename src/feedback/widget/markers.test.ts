/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkerThread } from "../protocol.ts";
import { createLayer, type Layer } from "./layer.ts";
import { createMarkers, DETACH_SETTLE_MS, type Markers } from "./markers.ts";

let layer: Layer;
let markers: Markers | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  layer = createLayer(document);
});

afterEach(() => {
  markers?.destroy();
  markers = undefined;
  layer.host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function thread(id: string, number: number, selector: string, text: string, status: MarkerThread["status"] = "open"): MarkerThread {
  return { id, number, status, anchor: { selector, text, tag: "button", rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 800, height: 600 } } };
}

function shown(): HTMLButtonElement[] {
  return Array.from(layer.root.querySelectorAll("button")).filter((button) => button.style.display !== "none");
}

describe("createMarkers", () => {
  it("should put a numbered, named marker beside each thread's element", async () => {
    document.body.innerHTML = `<button id="a">Save</button><button id="b">Back</button>`;
    markers = createMarkers(window, layer, { onClick: vi.fn(), onDetached: vi.fn() });
    markers.set([thread("t1", 1, "#a", "Save"), thread("t2", 2, "#b", "Back", "resolved")]);
    await vi.advanceTimersByTimeAsync(20);
    expect(shown().map((button) => [button.textContent, button.getAttribute("aria-label")])).toEqual([
      ["1", "Comment 1"],
      ["2", "Comment 2, resolved"]
    ]);
  });

  it("should ask the shell to open a thread when its marker is clicked", async () => {
    document.body.innerHTML = `<button id="a">Save</button>`;
    const onClick = vi.fn();
    markers = createMarkers(window, layer, { onClick, onDetached: vi.fn() });
    markers.set([thread("t1", 1, "#a", "Save")]);
    await vi.advanceTimersByTimeAsync(20);
    shown()[0]?.click();
    expect(onClick).toHaveBeenCalledWith("t1");
  });

  it("should report a thread detached once its element has stayed missing", async () => {
    document.body.innerHTML = `<button id="a">Save</button>`;
    const onDetached = vi.fn();
    markers = createMarkers(window, layer, { onClick: vi.fn(), onDetached });
    markers.set([thread("t1", 1, "#a", "Save"), thread("t2", 2, "#gone", "Gone")]);
    await vi.advanceTimersByTimeAsync(20);
    expect(onDetached).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DETACH_SETTLE_MS);
    expect(onDetached).toHaveBeenCalledWith(["t2"]);
    expect(shown()).toHaveLength(1);
  });

  it("should not report a thread whose element appears before the page settles", async () => {
    const onDetached = vi.fn();
    markers = createMarkers(window, layer, { onClick: vi.fn(), onDetached });
    markers.set([thread("t1", 1, "#a", "Save")]);
    await vi.advanceTimersByTimeAsync(20);
    document.body.innerHTML = `<button id="a">Save</button>`;
    await vi.advanceTimersByTimeAsync(DETACH_SETTLE_MS + 20);
    expect(onDetached).not.toHaveBeenCalled();
    expect(shown()).toHaveLength(1);
  });

  it("should take away the marker of a thread it is no longer told of", async () => {
    document.body.innerHTML = `<button id="a">Save</button>`;
    markers = createMarkers(window, layer, { onClick: vi.fn(), onDetached: vi.fn() });
    markers.set([thread("t1", 1, "#a", "Save")]);
    await vi.advanceTimersByTimeAsync(20);
    markers.set([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(layer.root.querySelectorAll("button")).toHaveLength(0);
  });

  it("should scroll to and outline a focused thread's element, and mark its marker", async () => {
    document.body.innerHTML = `<button id="a">Save</button>`;
    const scrolled = vi.fn();
    (document.querySelector("#a") as HTMLElement).scrollIntoView = scrolled;
    markers = createMarkers(window, layer, { onClick: vi.fn(), onDetached: vi.fn() });
    markers.set([thread("t1", 1, "#a", "Save")]);
    markers.focus("t1");
    await vi.advanceTimersByTimeAsync(20);
    expect(scrolled).toHaveBeenCalled();
    expect(shown()[0]?.style.outline).toContain("solid");
    const outline = Array.from(layer.root.children).find((element) => element instanceof HTMLDivElement && element.style.border !== "");
    expect((outline as HTMLElement).style.display).toBe("block");
    await vi.advanceTimersByTimeAsync(2100);
    expect((outline as HTMLElement).style.display).toBe("none");
  });

  it("should do nothing when told to focus a thread it cannot find", async () => {
    markers = createMarkers(window, layer, { onClick: vi.fn(), onDetached: vi.fn() });
    markers.focus("missing");
    await vi.advanceTimersByTimeAsync(20);
    expect(shown()).toHaveLength(0);
  });

  it("should show the focus ring while a marker has keyboard focus", async () => {
    document.body.innerHTML = `<button id="a">Save</button>`;
    markers = createMarkers(window, layer, { onClick: vi.fn(), onDetached: vi.fn() });
    markers.set([thread("t1", 1, "#a", "Save")]);
    await vi.advanceTimersByTimeAsync(20);
    const marker = shown()[0] as HTMLButtonElement;
    marker.dispatchEvent(new FocusEvent("focus"));
    expect(marker.style.outline).toContain("solid");
    marker.dispatchEvent(new FocusEvent("blur"));
    expect(marker.style.outline).toBe("none");
  });
});
