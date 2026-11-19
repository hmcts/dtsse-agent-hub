/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemButtons } from "@/components/assistant/ItemButtons";
import type { SwitcherItem } from "@/components/assistant/ItemSwitcher";

// jsdom has no layout, so the row's room and each button's width are set here.
const layout = { room: 0, button: 100 };
const resizes: (() => void)[] = [];

beforeEach(() => {
  layout.room = 1000;
  layout.button = 100;
  resizes.length = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.getAttribute("role") === "group" ? layout.room : layout.button;
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizes.push(callback);
      }
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function item(key: string, label: string, overrides: Partial<SwitcherItem> = {}): SwitcherItem {
  return { key, label, open: vi.fn(), ...overrides };
}

const FOUR = [item("a", "Alpha"), item("b", "Beta"), item("c", "Gamma"), item("d", "Delta")];

function row() {
  return within(screen.getByRole("group", { name: "Items" }));
}

function shown(): (string | null)[] {
  return row()
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-haspopup") === null)
    .map((button) => button.textContent);
}

describe("ItemButtons", () => {
  it("should show each item as its own button, with no overflow button, when they all fit", () => {
    layout.room = 1000;
    render(<ItemButtons items={FOUR} current={null} />);
    expect(shown()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(screen.queryByRole("button", { name: /more item/ })).toBeNull();
  });

  it("should open the item when its button is pressed", () => {
    const beta = item("b", "Beta");
    render(<ItemButtons items={[item("a", "Alpha"), beta]} current={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(beta.open).toHaveBeenCalledTimes(1);
  });

  it("should mark the open item current, and name each button for its state", () => {
    render(
      <ItemButtons items={[item("a", "Alpha", { waiting: true }), item("b", "Beta", { unsaved: true }), item("c", "Gamma", { failed: true })]} current="c" />
    );
    expect(screen.getByRole("button", { name: "Alpha, updated by the assistant" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: "Beta, with your unsaved changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gamma, which did not load" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("a-updated")).toBeTruthy();
    expect(screen.getByTestId("b-unsaved")).toBeTruthy();
    expect(screen.getByTestId("c-failed")).toBeTruthy();
  });

  it("should put the items that do not fit in the overflow menu, in order, when the row is too narrow", () => {
    layout.room = 320;
    render(<ItemButtons items={FOUR} current={null} />);
    expect(shown()).toEqual(["Alpha", "Beta"]);
    const more = screen.getByRole("button", { name: "2 more items" });
    fireEvent.click(more);
    expect(screen.getAllByRole("menuitemradio").map((entry) => entry.textContent)).toEqual(["Gamma", "Delta"]);
  });

  it("should show a dot on the overflow button only when a hidden item has a mark", () => {
    layout.room = 320;
    const { rerender } = render(<ItemButtons items={[...FOUR.slice(0, 3), item("d", "Delta", { waiting: true })]} current={null} />);
    expect(screen.getByRole("button", { name: "2 more items, with changes to see" })).toBeTruthy();

    rerender(<ItemButtons items={[item("a", "Alpha", { waiting: true }), ...FOUR.slice(1)]} current={null} />);
    expect(screen.getByRole("button", { name: "2 more items" })).toBeTruthy();
  });

  it("should keep the open item as a button, in place of the last that fits, when it would overflow", () => {
    layout.room = 320;
    render(<ItemButtons items={FOUR} current="d" />);
    expect(shown()).toEqual(["Alpha", "Delta"]);
    expect(screen.getByRole("button", { name: "Delta" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "2 more items" }));
    expect(screen.getAllByRole("menuitemradio").map((entry) => entry.textContent)).toEqual(["Beta", "Gamma"]);
  });

  it("should fit again when the row is resized", () => {
    layout.room = 320;
    render(<ItemButtons items={FOUR} current={null} />);
    expect(shown()).toHaveLength(2);

    layout.room = 1000;
    act(() => {
      for (const resize of resizes) {
        resize();
      }
    });
    expect(shown()).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /more item/ })).toBeNull();
  });

  it("should show the overflow button and only the open item when the row measures no width", () => {
    layout.room = 0;
    render(<ItemButtons items={FOUR} current="b" />);
    expect(shown()).toEqual(["Beta"]);
    expect(screen.getByRole("button", { name: "3 more items" })).toBeTruthy();
  });

  it("should show the overflow button and no item when the row measures no width and none is open", () => {
    layout.room = 0;
    render(<ItemButtons items={FOUR} current={null} />);
    expect(shown()).toEqual([]);
    expect(screen.getByRole("button", { name: "4 more items" })).toBeTruthy();
  });

  it("should show nothing when the conversation holds no item", () => {
    render(<ItemButtons items={[]} current={null} />);
    expect(row().queryAllByRole("button")).toEqual([]);
  });
});
