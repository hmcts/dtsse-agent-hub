/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayer, type Layer } from "./layer.ts";
import { isVisible, nextCandidate, pickCandidates, startPicking } from "./picker.ts";

let layer: Layer;
let stop: (() => void) | undefined;
const always = () => true;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  layer = createLayer(document);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  layer.host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

describe("pickCandidates", () => {
  it("should step through focusable and text-bearing elements in order, and not the widget's own", () => {
    document.body.innerHTML = `<div><h1>Title</h1><div><a href="#">Link</a></div><span> </span><input type="hidden"><input></div>`;
    expect(pickCandidates(document, layer, always).map((element) => element.localName)).toEqual(["h1", "a", "input"]);
  });

  it("should leave out what is not shown", () => {
    document.body.innerHTML = `<p>Hidden</p>`;
    expect(pickCandidates(document, layer)).toEqual([]);
    expect(isVisible(document.querySelector("p") as Element)).toBe(false);
  });
});

describe("nextCandidate", () => {
  const [a, b, c] = ["a", "b", "c"].map((tag) => document.createElement(tag)) as unknown as [Element, Element, Element];

  it("should start at the first, or the last going backwards", () => {
    expect(nextCandidate([a, b, c], undefined, false)).toBe(a);
    expect(nextCandidate([a, b, c], undefined, true)).toBe(c);
  });

  it("should wrap round both ways", () => {
    expect(nextCandidate([a, b, c], c, false)).toBe(a);
    expect(nextCandidate([a, b, c], a, true)).toBe(c);
    expect(nextCandidate([a, b, c], a, false)).toBe(b);
  });

  it("should find nothing among nothing", () => {
    expect(nextCandidate([], undefined, false)).toBeUndefined();
  });
});

describe("startPicking", () => {
  it("should choose the element clicked, without the page seeing the click", () => {
    document.body.innerHTML = `<button>Continue</button>`;
    const pageClick = vi.fn();
    document.querySelector("button")?.addEventListener("click", pageClick);
    const onPick = vi.fn();
    stop = startPicking(window, layer, { onPick, onCancel: vi.fn() }, always);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.querySelector("button")?.dispatchEvent(click);
    expect(onPick).toHaveBeenCalledWith(document.querySelector("button"));
    expect(pageClick).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
    document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(pageClick).toHaveBeenCalledTimes(1);
  });

  it("should outline what the pointer is over", async () => {
    document.body.innerHTML = `<p>Para</p>`;
    stop = startPicking(window, layer, { onPick: vi.fn(), onCancel: vi.fn() }, always);
    document.querySelector("p")?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const label = Array.from(layer.root.querySelectorAll("div")).find((element) => element.textContent === "p");
    expect(label?.style.display).toBe("block");
  });

  it("should cancel on Escape", () => {
    const onCancel = vi.fn();
    stop = startPicking(window, layer, { onPick: vi.fn(), onCancel }, always);
    expect(layer.root.querySelector("[role=status]")?.textContent).toContain("Escape cancels");
    expect(key("Escape").defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalled();
    expect(layer.root.querySelector("[role=status]")).toBeNull();
  });

  it("should move with Tab and Shift+Tab and choose with Enter", () => {
    document.body.innerHTML = `<h1>One</h1><p>Two</p><button>Three</button>`;
    const onPick = vi.fn();
    stop = startPicking(window, layer, { onPick, onCancel: vi.fn() }, always);
    key("Enter");
    expect(onPick).not.toHaveBeenCalled();
    key("Tab");
    key("Tab");
    key("Tab");
    key("Tab", { shiftKey: true });
    expect(key("Tab").defaultPrevented).toBe(true);
    key("Enter");
    expect(onPick).toHaveBeenCalledWith(document.querySelector("button"));
  });

  it("should start from the element that has focus", () => {
    document.body.innerHTML = `<input id="a"><input id="b">`;
    (document.querySelector("#b") as HTMLElement).focus();
    const onPick = vi.fn();
    stop = startPicking(window, layer, { onPick, onCancel: vi.fn() }, always);
    key(" ");
    expect(onPick).toHaveBeenCalledWith(document.querySelector("#b"));
  });

  it("should let other keys through", () => {
    stop = startPicking(window, layer, { onPick: vi.fn(), onCancel: vi.fn() }, always);
    expect(key("a").defaultPrevented).toBe(false);
  });
});
