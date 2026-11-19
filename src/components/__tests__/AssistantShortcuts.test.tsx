/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockTime, dayLabel, sameDay } from "@/assistant/grouping";
import { AssistantShell } from "@/components/assistant/AssistantShell";
import { composerPlaceholder } from "@/components/assistant/Composer";
import { ShortcutsDialog, sendsMessage, useModifierName, useSendKey } from "@/components/assistant/shortcuts";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/assistant",
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/components/live/HubStream", () => ({ useHubEvent: () => undefined, useEndSession: () => () => undefined }));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: query.includes("min-width"), addEventListener: () => undefined, removeEventListener: () => undefined })
  });
});

afterEach(() => {
  cleanup();
  push.mockReset();
  window.localStorage.clear();
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API, and the shell writes the cookie this way
  document.cookie = "asst_sidebar=; Path=/; Max-Age=0";
});

function shell() {
  return render(
    <AssistantShell viewerName="Alice Tester" groups={[]} activeId={null} now={Date.now()}>
      <textarea aria-label="Message" />
    </AssistantShell>
  );
}

function sidebar(): HTMLElement {
  return screen.getByRole("complementary", { name: "Conversations" });
}

describe("the shell's keyboard shortcuts", () => {
  it("should start a new chat on Ctrl+Shift+O", () => {
    shell();

    fireEvent.keyDown(document.body, { key: "O", ctrlKey: true, shiftKey: true });

    expect(push).toHaveBeenCalledWith("/assistant");
  });

  it("should close and open the sidebar on Ctrl+Shift+S", () => {
    shell();

    fireEvent.keyDown(document.body, { key: "s", metaKey: true, shiftKey: true });
    expect(sidebar().hasAttribute("inert")).toBe(true);

    fireEvent.keyDown(document.body, { key: "s", metaKey: true, shiftKey: true });
    expect(sidebar().hasAttribute("inert")).toBe(false);
  });

  it("should open the sidebar and put focus in search on Ctrl+K, even with the sidebar closed", () => {
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    act(() => {
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    });

    expect(sidebar().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(sidebar().querySelector('input[aria-label="Search"]'));
  });

  it("should go to the message box on Shift+Escape", () => {
    shell();

    fireEvent.keyDown(document.body, { key: "Escape", shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
  });

  it("should show the shortcuts on ? and from the sidebar's button, but not while the person is typing", () => {
    shell();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();

    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close keyboard shortcuts" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("should leave the keys alone while a dialog is open, or when something else took them", () => {
    shell();
    fireEvent.keyDown(document.body, { key: "?" });

    fireEvent.keyDown(document.body, { key: "O", ctrlKey: true, shiftKey: true });
    expect(push).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    const taken = new KeyboardEvent("keydown", { key: "O", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    taken.preventDefault();
    window.dispatchEvent(taken);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("ShortcutsDialog", () => {
  it("should list the shortcuts, and keep the choice of send key in this browser", () => {
    render(<ShortcutsDialog onClose={() => undefined} />);

    expect(screen.getByText("Ctrl+K")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Ctrl\+Enter sends/ }));
    expect(window.localStorage.getItem("asst-send-key")).toBe("mod-enter");

    fireEvent.click(screen.getByRole("radio", { name: /^Enter sends/ }));
    expect(window.localStorage.getItem("asst-send-key")).toBeNull();
  });

  it("should write the shortcuts with ⌘ on a Mac", () => {
    const platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<ShortcutsDialog onClose={() => undefined} />);

    expect(screen.getByText("⌘+K")).toBeTruthy();
    platform.mockRestore();
  });
});

describe("useSendKey", () => {
  function Probe() {
    const [key] = useSendKey();
    return <span>{key}</span>;
  }

  it("should follow a change made in another tab, and fall back to Enter when storage cannot be read", () => {
    render(<Probe />);
    expect(screen.getByText("enter")).toBeTruthy();

    act(() => {
      window.localStorage.setItem("asst-send-key", "mod-enter");
      window.dispatchEvent(new StorageEvent("storage"));
    });
    expect(screen.getByText("mod-enter")).toBeTruthy();

    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    act(() => {
      window.dispatchEvent(new StorageEvent("storage"));
    });
    expect(screen.getByText("enter")).toBeTruthy();
    getItem.mockRestore();
  });

  it("should still apply a choice it cannot store", () => {
    function Chooser() {
      const [key, choose] = useSendKey();
      return (
        <button type="button" onClick={() => choose("mod-enter")}>
          {key}
        </button>
      );
    }
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    render(<Chooser />);

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("button").textContent).toBe("mod-enter");
    setItem.mockRestore();
  });
});

describe("useModifierName", () => {
  it("should say Ctrl away from a Mac", () => {
    function Probe() {
      return <span>{useModifierName()}</span>;
    }
    render(<Probe />);

    expect(screen.getByText("Ctrl")).toBeTruthy();
  });
});

describe("sendsMessage", () => {
  const press = (key: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...extra
  });

  it("should send on Enter by default, with Ctrl or Cmd too, and never with Shift or mid-composition", () => {
    expect(sendsMessage(press("Enter"), "enter")).toBe(true);
    expect(sendsMessage(press("Enter", { ctrlKey: true }), "enter")).toBe(true);
    expect(sendsMessage(press("Enter", { metaKey: true }), "enter")).toBe(true);
    expect(sendsMessage(press("Enter", { shiftKey: true }), "enter")).toBe(false);
    expect(sendsMessage(press("Enter", { isComposing: true }), "enter")).toBe(false);
    expect(sendsMessage(press("a"), "enter")).toBe(false);
  });

  it("should send on Ctrl or Cmd with Enter when the person chose that", () => {
    expect(sendsMessage(press("Enter"), "mod-enter")).toBe(false);
    expect(sendsMessage(press("Enter", { ctrlKey: true }), "mod-enter")).toBe(true);
    expect(sendsMessage(press("Enter", { metaKey: true }), "mod-enter")).toBe(true);
  });
});

describe("composerPlaceholder", () => {
  it("should mention only what the box can do here", () => {
    expect(composerPlaceholder(true, true)).toBe("Message CFT Workspace. Type / for skills, or drop files here");
    expect(composerPlaceholder(true, false)).toBe("Message CFT Workspace. Type / for skills");
    expect(composerPlaceholder(false, true)).toBe("Message CFT Workspace, or drop files here");
    expect(composerPlaceholder(false, false)).toBe("Message CFT Workspace");
  });
});

describe("dayLabel", () => {
  const now = new Date("2026-11-19T12:00:00Z");

  it("should say Today and Yesterday by the day in London, and Today for a moment ahead of a slow clock", () => {
    expect(dayLabel(new Date("2026-11-19T00:30:00Z"), now)).toBe("Today");
    expect(dayLabel(new Date("2026-11-20T00:05:00Z"), now)).toBe("Today");
    expect(dayLabel(new Date("2026-11-18T23:59:00Z"), now)).toBe("Yesterday");
  });

  it("should name an older day, with its year only once it is not this year", () => {
    expect(dayLabel(new Date("2026-11-03T09:00:00Z"), now)).toBe("Tuesday 3 November");
    expect(dayLabel(new Date("2025-11-03T09:00:00Z"), now)).toBe("Monday 3 November 2025");
  });

  it("should tell two instants on the same London day from two on different days", () => {
    expect(sameDay(new Date("2026-06-30T23:30:00Z"), new Date("2026-07-01T09:00:00Z"))).toBe(true);
    expect(sameDay(new Date("2026-06-30T22:30:00Z"), new Date("2026-07-01T09:00:00Z"))).toBe(false);
  });

  it("should give the time of day in London", () => {
    expect(clockTime(new Date("2026-06-30T23:30:00Z"))).toBe("00:30");
  });
});
