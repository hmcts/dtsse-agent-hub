/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationLink } from "@/assistant/views";
import { AssistantShell, type ConversationActions } from "@/components/assistant/AssistantShell";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }), usePathname: () => "/assistant" }));

vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: () => undefined,
  useEndSession: () => () => undefined
}));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
});

afterEach(() => {
  cleanup();
  refresh.mockReset();
  push.mockReset();
});

function link(id: string, title: string): ConversationLink {
  return { id, title, product: "ccd", productLabel: "CCD", lastActiveAt: "2026-10-21T09:00:00.000Z" };
}

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

function actions(overrides: Partial<ConversationActions> = {}): ConversationActions {
  return { rename: ok(), remove: ok(), ...overrides };
}

/** The sidebar with two chats, the second of which, "Story draft", is the one open. */
function shell(props: { actions?: ConversationActions } = {}) {
  return (
    <AssistantShell
      viewerName="Alice Smith"
      groups={[{ label: "Today", items: [link("a", "Event help"), link("b", "Story draft")] }]}
      activeId="b"
      hubLink={false}
      {...props}
    >
      <p>page</p>
    </AssistantShell>
  );
}

function row(title: string): HTMLElement {
  return within(screen.getByRole("navigation", { name: "Chats" })).getByRole("link", { name: title }).parentElement!;
}

function openMenu(title: string): void {
  fireEvent.click(within(row(title)).getByRole("button", { name: `Options for ${title}` }));
}

describe("AssistantShell conversation menu", () => {
  it("should offer no options menu when the sidebar is given no actions", () => {
    render(shell());

    expect(screen.queryByRole("button", { name: /^Options for/ })).toBeNull();
  });

  it("should name each chat's menu after it and keep the trigger out of the link when the rows have actions", () => {
    render(shell({ actions: actions() }));

    const trigger = within(row("Event help")).getByRole("button", { name: "Options for Event help" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // An anchor may not hold a button: the trigger is the link's sibling, not inside it.
    expect(within(screen.getByRole("link", { name: "Event help" })).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Options for/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Options for Event help",
      "Options for Story draft"
    ]);
  });

  it("should reach the trigger with the keyboard and open the menu with it when tabbing through a row", () => {
    render(shell({ actions: actions() }));

    const trigger = within(row("Event help")).getByRole("button", { name: "Options for Event help" });
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(trigger.getAttribute("tabindex")).toBeNull();
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);

    expect(screen.getByRole("menu", { name: "Options for Event help" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("should rename the chat and close the menu when the person saves a new name from a row", async () => {
    const rename = ok();
    render(shell({ actions: actions({ rename }) }));

    openMenu("Event help");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const box = screen.getByRole("textbox", { name: "Chat name" }) as HTMLInputElement;
    expect(box.value).toBe("Event help");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "Renamed from the sidebar" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(rename).toHaveBeenCalledWith({ conversationId: "a", title: "Renamed from the sidebar" });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull();
  });

  it("should show the refusal beside the chat when it cannot be renamed", async () => {
    render(shell({ actions: actions({ rename: vi.fn(async () => ({ ok: false as const, error: "a title is 1 to 200 characters" })) }) }));

    openMenu("Event help");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(within(row("Event help")).getByRole("alert").textContent).toBe("a title is 1 to 200 characters");
  });

  it("should ask before deleting and do nothing when the person backs out", async () => {
    const remove = ok();
    render(shell({ actions: actions({ remove }) }));

    openMenu("Event help");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    expect(screen.getByText("Delete this chat and its document? This cannot be undone.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(remove).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("should go to a new chat when the person deletes the chat they are looking at", async () => {
    const remove = ok();
    render(shell({ actions: actions({ remove }) }));

    openMenu("Story draft");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(remove).toHaveBeenCalledWith({ conversationId: "b" });
    expect(push).toHaveBeenCalledWith("/assistant");
  });

  it("should only read the list again when the person deletes a chat they are not looking at", async () => {
    const remove = ok();
    render(shell({ actions: actions({ remove }) }));

    openMenu("Event help");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(remove).toHaveBeenCalledWith({ conversationId: "a" });
    expect(push).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  it("should show the refusal and stay when a chat cannot be deleted", async () => {
    render(shell({ actions: actions({ remove: vi.fn(async () => ({ ok: false as const, error: "gone already" })) }) }));

    openMenu("Story draft");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(push).not.toHaveBeenCalled();
    expect(within(row("Story draft")).getByRole("alert").textContent).toBe("gone already");
  });

  it("should close the menu when the person presses Escape", () => {
    render(shell({ actions: actions() }));

    openMenu("Event help");
    expect(screen.getByRole("menu", { name: "Options for Event help" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should close the menu when the person clicks outside it", () => {
    render(shell({ actions: actions() }));

    openMenu("Event help");
    expect(screen.getByRole("menu", { name: "Options for Event help" })).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("page"));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should close the menu when the person clicks the trigger again", () => {
    render(shell({ actions: actions() }));

    openMenu("Event help");
    openMenu("Event help");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(row("Event help")).getByRole("button", { name: "Options for Event help" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("should leave the other row's menu shut when one row's menu is open", () => {
    render(shell({ actions: actions() }));

    openMenu("Event help");

    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(within(row("Story draft")).getByRole("button", { name: "Options for Story draft" }).getAttribute("aria-expanded")).toBe("false");
  });
});
