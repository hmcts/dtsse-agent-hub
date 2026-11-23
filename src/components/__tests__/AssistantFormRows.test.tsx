/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormLink, SidebarItem } from "@/assistant/views";
import { AssistantShell, type ConversationActions } from "@/components/assistant/AssistantShell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/assistant",
  useSearchParams: () => new URLSearchParams(window.location.search)
}));

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
});

function form(overrides: Partial<FormLink> = {}): FormLink {
  return {
    kind: "form",
    id: "f1",
    title: "T210 claim form",
    lastActiveAt: "2026-10-21T09:00:00.000Z",
    pinnedAt: null,
    marked: true,
    signedOff: false,
    ...overrides
  };
}

const ok = () => vi.fn(async () => ({ ok: true as const }));
const actions: ConversationActions = { rename: ok(), pin: ok(), remove: ok(), pinFeedback: ok(), archiveFeedback: ok() };

function shell(items: SidebarItem[]) {
  return (
    <AssistantShell now={Date.now()} viewerName="Alice Smith" groups={[{ label: "Today", items }]} activeId={null} actions={actions}>
      <p>page</p>
    </AssistantShell>
  );
}

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Chats" });
}

describe("a Bulk Scan form's row", () => {
  it("should link to the form's editor with the form icon and its name when the list holds another kind", () => {
    render(shell([form()]));

    const link = within(nav()).getByRole("link", { name: /^Bulk Scan form:\s*T210 claim form$/ });
    expect(link.getAttribute("href")).toBe("/assistant/bulk-scan/f1");
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("should carry no icon when the list holds forms alone", () => {
    render(shell([form({ marked: false })]));

    expect(within(nav()).getByRole("link", { name: "T210 claim form" }).querySelector("svg")).toBeNull();
  });

  it("should say the latest version is signed off in words when it is", () => {
    render(shell([form({ signedOff: true })]));

    expect(within(nav()).getByRole("link", { name: /T210 claim form, signed off$/ })).toBeTruthy();
  });

  it("should say nothing of sign-off when the latest version is not signed off", () => {
    render(shell([form()]));

    expect(within(nav()).getByRole("link", { name: /^Bulk Scan form:\s*T210 claim form$/ }).textContent).not.toContain("signed off");
  });

  it("should offer no options menu when it is a form's row", () => {
    render(shell([form()]));

    expect(within(nav()).queryByRole("button", { name: /Options for/ })).toBeNull();
  });

  it("should be reachable and openable by keyboard when tabbing through the list", async () => {
    const user = userEvent.setup();
    render(shell([form()]));

    const link = within(nav()).getByRole("link", { name: /T210 claim form/ });
    for (let presses = 0; presses < 20 && document.activeElement !== link; presses++) {
      await user.tab();
    }

    expect(document.activeElement).toBe(link);
  });
});
