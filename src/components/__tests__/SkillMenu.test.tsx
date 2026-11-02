/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@/agents/skills";
import { TEMPLATES } from "@/assistant/starters";
import { Composer } from "@/components/assistant/Composer";

/**
 * `useSkillMenu`'s ranking and keyboard, through the composer that themes it. The cases the Assistant's own composer
 * tests leave to the hook are here.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }), usePathname: () => "/assistant" }));

const VIEWER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONVERSATION = "22222222-2222-2222-2222-222222222222";

const SKILLS: Skill[] = [
  { name: "cft-explain", description: "Answer a what is X question" },
  { name: "cft-how-to", description: "Find a how-to recipe" },
  { name: "pcs:start-env", description: "Start an environment out of hours" },
  { name: "repo-sync", description: "Fast-forward cloned repos; explain what was skipped" }
];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

function composer(skills: Skill[] = SKILLS) {
  render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId={CONVERSATION} onSend={vi.fn(async () => null)} skills={skills} />);
}

function field(): HTMLTextAreaElement {
  return screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
}

function write(value: string): void {
  fireEvent.change(field(), { target: { value } });
}

function options(): string[] {
  return screen.queryAllByRole("option").map((option) => option.firstElementChild?.textContent ?? "");
}

describe("useSkillMenu ranking", () => {
  it("should list name-prefix matches before description matches when a query is typed", () => {
    composer();

    write("/expl");
    expect(options()).toEqual(["/repo-sync"]);
    write("/cft-ex");
    expect(options()).toEqual(["/cft-explain"]);
    write("/EXPLAIN");
    expect(options()).toEqual(["/repo-sync"]);
  });

  it("should put a name match first when the query matches one name and another's description", () => {
    composer([
      { name: "find", description: "Search" },
      { name: "search", description: "Look things up" }
    ]);

    write("/search");

    expect(options()).toEqual(["/search", "/find"]);
  });

  it("should show nothing when the slash does not start the message", () => {
    composer();

    write("please /cft");

    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("should close the list when the caret moves past the leading token", () => {
    composer();

    write("/cft and more");

    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  it("should show nothing when no skill matches", () => {
    composer();

    write("/zzz");

    expect(field().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("useSkillMenu keyboard", () => {
  it("should mark only the active option as selected when the arrow keys move it", () => {
    composer();
    write("/cft");

    fireEvent.keyDown(field(), { key: "ArrowDown" });

    expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  });

  it("should pick the active skill when Tab is pressed", () => {
    composer();
    write("/pcs");

    fireEvent.keyDown(field(), { key: "Tab" });

    expect(field().value).toBe("/pcs:start-env ");
  });

  it("should replace only the leading token and keep the rest when a skill is picked", () => {
    composer();
    write("/cf what is CDAM?");
    field().setSelectionRange(3, 3);
    fireEvent.select(field());

    fireEvent.keyDown(field(), { key: "Enter" });

    expect(field().value).toBe("/cft-explain what is CDAM?");
    expect(field().selectionStart).toBe("/cft-explain ".length);
  });

  it("should keep the list open and pick nothing when a key the menu does not own is pressed", () => {
    composer();
    write("/cft");

    fireEvent.keyDown(field(), { key: "Home" });

    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(field().value).toBe("/cft");
  });

  it("should pick the skill and leave the box focused when an option is reached by keyboard and entered", () => {
    composer();
    write("/");
    const option = screen.getByRole("option", { name: /cft-how-to/ });

    fireEvent.mouseDown(option);
    fireEvent.keyDown(option, { key: "Enter" });

    expect(field().value).toBe("/cft-how-to ");
    expect(document.activeElement).toBe(field());
  });
});
