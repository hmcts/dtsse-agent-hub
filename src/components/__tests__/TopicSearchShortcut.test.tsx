/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isTextField, TopicSearchShortcut } from "@/components/sidebar/TopicSearchShortcut";

afterEach(() => {
  cleanup();
});

function page(extra?: React.ReactNode) {
  render(
    <>
      <TopicSearchShortcut />
      <input id="sidebar-topic-search" aria-label="Sidebar search" aria-keyshortcuts="/" />
      <button type="button">Elsewhere</button>
      <input type="checkbox" aria-label="A checkbox" />
      <textarea aria-label="Message" />
      {extra}
    </>
  );
}

describe("isTextField", () => {
  it.each<[string, () => EventTarget | null, boolean]>([
    ["a text input", () => document.createElement("input"), true],
    ["a search input", () => Object.assign(document.createElement("input"), { type: "search" }), true],
    ["a checkbox", () => Object.assign(document.createElement("input"), { type: "checkbox" }), false],
    ["a textarea", () => document.createElement("textarea"), true],
    ["a select", () => document.createElement("select"), true],
    ["a button", () => document.createElement("button"), false],
    ["the document", () => document, false],
    ["nothing", () => null, false]
  ])("should decide whether %s is typed into when given it", (_, make, expected) => {
    expect(isTextField(make())).toBe(expected);
  });

  it("should treat an editable element as a text field when it is content-editable", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });

    expect(isTextField(div)).toBe(true);
  });
});

describe("TopicSearchShortcut", () => {
  it("should focus the sidebar's topic search when / is pressed outside a text field", () => {
    page();
    const button = screen.getByRole("button", { name: "Elsewhere" });
    button.focus();

    const allowed = fireEvent.keyDown(button, { key: "/" });

    expect(allowed).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText("Sidebar search"));
  });

  it("should open the collapsed group holding the sidebar's search when / is pressed", () => {
    render(
      <>
        <TopicSearchShortcut />
        <details>
          <summary>Topics</summary>
          <input id="sidebar-topic-search" aria-label="Sidebar search" />
        </details>
      </>
    );

    fireEvent.keyDown(document.body, { key: "/" });

    expect((screen.getByRole("group") as HTMLDetailsElement).open).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("Sidebar search"));
  });

  it("should focus the topics page's own search before the sidebar's when both are shown", () => {
    page(<input id="topic-search" aria-label="Page search" />);

    fireEvent.keyDown(screen.getByLabelText("A checkbox"), { key: "/" });

    expect(document.activeElement).toBe(screen.getByLabelText("Page search"));
  });

  it("should leave / alone when it is typed into a text field or pressed with a modifier", () => {
    page();
    const message = screen.getByLabelText("Message");
    message.focus();

    expect(fireEvent.keyDown(message, { key: "/" })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "/", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "/", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "/", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "k" })).toBe(true);

    expect(document.activeElement).toBe(message);
  });

  it("should do nothing when there is no topic search on the page", () => {
    render(<TopicSearchShortcut />);

    expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(true);
  });

  it("should leave / alone when something else has already handled it", () => {
    page();
    const button = screen.getByRole("button", { name: "Elsewhere" });
    button.focus();
    button.addEventListener("keydown", (event) => event.preventDefault());

    fireEvent.keyDown(button, { key: "/" });

    expect(document.activeElement).toBe(button);
  });

  it("should stop listening when it unmounts", () => {
    const { unmount } = render(
      <>
        <TopicSearchShortcut />
        <input id="sidebar-topic-search" aria-label="Sidebar search" />
      </>
    );
    unmount();
    render(<input id="sidebar-topic-search" aria-label="Sidebar search" />);

    expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });
});
