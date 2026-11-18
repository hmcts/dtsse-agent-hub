/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemSwitcher, type SwitcherItem } from "@/components/assistant/ItemSwitcher";

afterEach(cleanup);

function item(key: string, label: string, overrides: Partial<SwitcherItem> = {}): SwitcherItem {
  return { key, label, open: vi.fn(), ...overrides };
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: /^Items/ });
}

describe("ItemSwitcher", () => {
  it("should show nothing when the conversation holds no item", () => {
    const { container } = render(<ItemSwitcher items={[]} current={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("should name the trigger Items when no item is open, and the open item when one is", () => {
    const items = [item("document", "Document"), item("slides", "Slides")];
    const { rerender } = render(<ItemSwitcher items={items} current={null} />);
    expect(trigger().getAttribute("aria-label")).toBe("Items");
    expect(trigger().textContent).toContain("Items");

    rerender(<ItemSwitcher items={items} current="slides" />);
    expect(trigger().getAttribute("aria-label")).toBe("Items, Slides open");
    expect(trigger().textContent).toContain("Slides");
  });

  it("should list every item with the open one checked, and open the one chosen, when the menu is opened", () => {
    const slides = item("slides", "Slides");
    render(<ItemSwitcher items={[item("document", "Document"), slides]} current="document" />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Document", "Slides"]);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Slides" }));
    expect(slides.open).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Items" })).toBeNull();
  });

  it("should mark the trigger and the row, and name the row's state, when an item is waiting or unsaved", () => {
    render(
      <ItemSwitcher
        items={[item("document", "Document", { unsaved: true, waiting: true }), item("slides", "Slides", { waiting: true }), item("notify", "Notify template")]}
        current={null}
      />
    );
    expect(trigger().getAttribute("aria-label")).toBe("Items, with changes to see");

    fireEvent.click(trigger());
    expect(screen.getByRole("menuitemradio", { name: "Document, with your unsaved changes" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Slides, updated by the assistant" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Notify template" })).toBeTruthy();
    expect(screen.getByTestId("document-unsaved")).toBeTruthy();
    expect(screen.queryByTestId("document-updated")).toBeNull();
    expect(screen.getByTestId("slides-updated")).toBeTruthy();
  });

  it("should mark the row and name it as not loaded when a load into the item failed", () => {
    render(<ItemSwitcher items={[item("docmosis", "Docmosis template", { failed: true })]} current={null} />);
    expect(trigger().getAttribute("aria-label")).toBe("Items, with changes to see");

    fireEvent.click(trigger());
    expect(screen.getByRole("menuitemradio", { name: "Docmosis template, which did not load" })).toBeTruthy();
    expect(screen.getByTestId("docmosis-failed")).toBeTruthy();
  });

  it("should come back closed when the list empties with the menu open and an item then returns", () => {
    const items = [item("document", "Document")];
    const { rerender } = render(<ItemSwitcher items={items} current={null} />);
    fireEvent.click(trigger());
    expect(screen.getByRole("menu", { name: "Items" })).toBeTruthy();

    rerender(<ItemSwitcher items={[]} current={null} />);
    rerender(<ItemSwitcher items={items} current={null} />);
    expect(screen.queryByRole("menu", { name: "Items" })).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("should leave the trigger unmarked when nothing is waiting", () => {
    render(<ItemSwitcher items={[item("document", "Document")]} current={null} />);
    expect(trigger().getAttribute("aria-label")).toBe("Items");
    expect(trigger().className).toContain("border-asst-strong");
  });

  it("should focus the first row, and move and wrap with the arrows, Home and End, when opened with ArrowDown", () => {
    render(<ItemSwitcher items={[item("document", "Document"), item("slides", "Slides"), item("docmosis", "Docmosis template")]} current={null} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const [first, second, third] = screen.getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  it("should focus the last row when opened with ArrowUp", () => {
    render(<ItemSwitcher items={[item("document", "Document"), item("slides", "Slides")]} current={null} />);
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Slides" }));
  });

  it("should close and put focus back on the trigger when Escape is pressed in the menu", () => {
    render(<ItemSwitcher items={[item("document", "Document")]} current={null} />);
    fireEvent.click(trigger());
    const row = screen.getByRole("menuitemradio", { name: "Document" });
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Items" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("should close when the person clicks outside it, or tabs away", () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <ItemSwitcher items={[item("document", "Document")]} current={null} />
      </>
    );
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu", { name: "Items" })).toBeNull();

    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "Document" }), { key: "Tab" });
    expect(screen.queryByRole("menu", { name: "Items" })).toBeNull();
  });

  it("should close when the trigger is pressed again", () => {
    render(<ItemSwitcher items={[item("document", "Document")]} current={null} />);
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByRole("menu", { name: "Items" })).toBeNull();
  });
});
