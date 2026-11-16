/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationLink, FeedbackProjectLink, SidebarItem } from "@/assistant/views";
import { AssistantShell, type ConversationActions } from "@/components/assistant/AssistantShell";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
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
  refresh.mockReset();
  push.mockReset();
  vi.unstubAllGlobals();
});

function project(overrides: Partial<FeedbackProjectLink> = {}): FeedbackProjectLink {
  return {
    kind: "feedback",
    id: "p1",
    title: "Claim journey",
    lastActiveAt: "2026-10-21T09:00:00.000Z",
    pinnedAt: null,
    marked: true,
    unread: 0,
    archivable: false,
    links: [{ label: "Alpha", token: "tokenA" }],
    ...overrides
  };
}

function chat(): ConversationLink {
  return {
    kind: "cloud",
    id: "c1",
    title: "Event help",
    product: "ccd",
    productLabel: "CCD",
    lastActiveAt: "2026-10-21T09:00:00.000Z",
    pinnedAt: null,
    mark: { where: "assistant", session: "ready" }
  };
}

const ok = () => vi.fn(async () => ({ ok: true as const }));

function actions(overrides: Partial<ConversationActions> = {}): ConversationActions {
  return { rename: ok(), pin: ok(), remove: ok(), pinFeedback: ok(), archiveFeedback: ok(), ...overrides };
}

function shell(items: SidebarItem[], props: { actions?: ConversationActions; activeId?: string | null } = {}) {
  return (
    <AssistantShell now={Date.now()} viewerName="Alice Smith" groups={[{ label: "Today", items }]} activeId={null} actions={actions()} {...props}>
      <p>page</p>
    </AssistantShell>
  );
}

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Chats" });
}

function openMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: "Options for Claim journey" }));
}

describe("a feedback project's row", () => {
  it("should link to the project's page with the feedback icon when the list holds another kind", () => {
    render(shell([chat(), project()]));

    const link = within(nav()).getByRole("link", { name: /^Feedback project:\s*Claim journey$/ });
    expect(link.getAttribute("href")).toBe("/assistant/feedback/p1");
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("should carry no icon when the list holds feedback projects alone", () => {
    render(shell([project({ marked: false })]));

    const link = within(nav()).getByRole("link", { name: "Claim journey" });
    expect(link.querySelector("svg")).toBeNull();
  });

  it("should be the current page when its project is the one open", () => {
    render(shell([project()], { activeId: "p1" }));

    expect(
      within(nav())
        .getByRole("link", { name: /Claim journey/ })
        .getAttribute("aria-current")
    ).toBe("page");
  });

  it("should show how many new comments and recordings it has, in words for a screen reader", () => {
    render(shell([project({ marked: false, unread: 3 })]));

    const link = within(nav()).getByRole("link", { name: /Claim journey/ });
    expect(link.textContent).toBe("Claim journey3, 3 new");
  });

  it("should cap the count at 99+ when more than 99 are new", () => {
    render(shell([project({ marked: false, unread: 140 })]));

    expect(within(nav()).getByRole("link", { name: /Claim journey/ }).textContent).toBe("Claim journey99+, 99+ new");
  });

  it("should show no count when nothing is new", () => {
    render(shell([project({ marked: false })]));

    expect(within(nav()).getByRole("link", { name: /Claim journey/ }).textContent).toBe("Claim journey");
  });
});

describe("a feedback project's menu", () => {
  it("should offer pin and copy but not archive when the viewer is on the team but not its owner", () => {
    render(shell([project()]));

    openMenu();

    const items = within(screen.getByRole("menu", { name: "Options for Claim journey" }))
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).toEqual(["Pin", "Copy share link"]);
  });

  it("should offer archive when the viewer owns it, and no copy when it has no live link", () => {
    render(shell([project({ archivable: true, links: [] })]));

    openMenu();

    const items = within(screen.getByRole("menu", { name: "Options for Claim journey" }))
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).toEqual(["Pin", "Archive project"]);
  });

  it("should pin it for the viewer when Pin is chosen, and offer Unpin once it is pinned", async () => {
    const pinFeedback = ok();
    const { rerender } = render(shell([project()], { actions: actions({ pinFeedback }) }));

    openMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Pin" })));
    expect(pinFeedback).toHaveBeenCalledWith({ projectId: "p1", pinned: true });

    rerender(shell([project({ pinnedAt: "2026-10-21T10:00:00.000Z" })], { actions: actions({ pinFeedback }) }));
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Unpin" })).toBeTruthy();
  });

  it("should copy the review address of its one link and say that it did", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(shell([project()]));

    openMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Copy share link" })));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/review/tokenA`);
    expect(screen.getByText("Share link copied.").getAttribute("role")).toBe("status");
  });

  it("should list the links by label and copy the one chosen when it has several", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      shell([
        project({
          links: [
            { label: "Alpha", token: "tokenA" },
            { label: "Beta", token: "tokenB" }
          ]
        })
      ])
    );

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy share link" }));
    await act(async () => fireEvent.click(within(screen.getByRole("menu", { name: "Copy share link" })).getByRole("menuitem", { name: "Beta" })));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/review/tokenB`);
  });

  it("should say the link could not be copied when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
    render(shell([project()]));

    openMenu();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Copy share link" })));

    expect(screen.getByRole("alert").textContent).toContain("could not be copied");
  });

  it("should archive it only once the owner confirms", async () => {
    const archiveFeedback = ok();
    render(shell([project({ archivable: true })], { actions: actions({ archiveFeedback }) }));

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive project" }));
    expect(archiveFeedback).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Archive" })));

    expect(archiveFeedback).toHaveBeenCalledWith({ projectId: "p1" });
    expect(push).not.toHaveBeenCalled();
  });

  it("should leave the project's page for the list when the open project is archived", async () => {
    render(shell([project({ archivable: true })], { activeId: "p1" }));

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive project" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Archive" })));

    expect(push).toHaveBeenCalledWith("/assistant/feedback");
  });

  it("should show the refusal under the row when archiving is refused", async () => {
    const archiveFeedback = vi.fn(async () => ({ ok: false as const, error: "only the project's owner can change it" }));
    render(shell([project({ archivable: true })], { actions: actions({ archiveFeedback }) }));

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive project" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Archive" })));

    expect(screen.getByRole("alert").textContent).toBe("only the project's owner can change it");
  });
});
