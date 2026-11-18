/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateMenu, type CreateOption } from "@/components/assistant/CreateMenu";

afterEach(cleanup);

function option(key: string, label: string, overrides: Partial<CreateOption> = {}): CreateOption {
  return { key, label, choose: vi.fn(), ...overrides };
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: "Create" });
}

describe("CreateMenu", () => {
  it("should offer every option given, in order, as menu items when opened", () => {
    render(<CreateMenu options={[option("document", "Document"), option("slides", "Slides"), option("notify", "Notify template")]} />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((row) => row.getAttribute("aria-label"))).toEqual(["Document", "Slides", "Notify template"]);
  });

  it("should say an option opens what the chat already holds when it exists", () => {
    render(<CreateMenu options={[option("document", "Document", { exists: true }), option("slides", "Slides")]} />);
    fireEvent.click(trigger());
    expect(screen.getByRole("menuitem", { name: "Document, already in this chat" }).textContent).toContain("Open");
    expect(screen.getByRole("menuitem", { name: "Slides" }).textContent).not.toContain("Open");
  });

  it("should run the chosen option and close the menu when an option is chosen", () => {
    const slides = option("slides", "Slides");
    render(<CreateMenu options={[option("document", "Document"), slides]} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: "Slides" }));

    expect(slides.choose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Create" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("should move between the options, and close with focus back on the trigger, when the arrow keys and Escape are pressed", () => {
    render(<CreateMenu options={[option("document", "Document"), option("slides", "Slides")]} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const [document_, slides] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(document_);
    fireEvent.keyDown(document_ as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(slides);
    fireEvent.keyDown(slides as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(document_);

    fireEvent.keyDown(document_ as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Create" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("should leave a key it has no use for alone when one is pressed in the menu", () => {
    render(<CreateMenu options={[option("document", "Document")]} />);
    fireEvent.click(trigger());
    const row = screen.getByRole("menuitem", { name: "Document" });
    fireEvent.keyDown(row, { key: "a" });
    expect(document.activeElement).toBe(row);
    expect(screen.getByRole("menu", { name: "Create" })).toBeTruthy();
  });
});
