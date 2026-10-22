/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationLink } from "@/assistant/views";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { AssistantRefresh } from "@/components/assistant/AssistantRefresh";
import { AssistantShell, SidebarToggle } from "@/components/assistant/AssistantShell";
import { ProductSelect } from "@/components/assistant/ProductSelect";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/assistant" }));

const hubHandlers = new Map<string, (data: unknown) => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: (data: unknown) => void) => hubHandlers.set(type, handler),
  useEndSession: () => () => undefined
}));

let narrow = false;

beforeEach(() => {
  narrow = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: narrow, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
});

afterEach(() => {
  cleanup();
  refresh.mockReset();
  hubHandlers.clear();
  vi.useRealTimers();
});

function link(id: string, title: string): ConversationLink {
  return { id, title, product: "ccd", productLabel: "CCD", lastActiveAt: "2026-10-21T09:00:00.000Z" };
}

function shell(props: Partial<Parameters<typeof AssistantShell>[0]> = {}) {
  return (
    <AssistantShell
      viewerName="Alice Smith"
      groups={[
        { label: "Today", items: [link("a", "Event help"), link("b", "Story draft")] },
        { label: "Older", items: [link("c", "Old chat")] }
      ]}
      activeId="b"
      hubLink={false}
      {...props}
    >
      <SidebarToggle />
      <p>page</p>
    </AssistantShell>
  );
}

function sidebar(): HTMLElement {
  return screen.getByRole("complementary", { name: "Conversations", hidden: true });
}

describe("AssistantShell", () => {
  it("should list the chats under their date headings and mark the open one when rendering the sidebar", () => {
    render(shell());

    const nav = screen.getByRole("navigation", { name: "Chats" });
    expect(
      within(nav)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent)
    ).toEqual(["Today", "Older"]);
    expect(within(nav).getByRole("link", { name: "Story draft" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Story draft" }).getAttribute("href")).toBe("/assistant/b");
    expect(within(nav).getByRole("link", { name: "Event help" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: /New chat/ }).getAttribute("href")).toBe("/assistant");
    expect(screen.getByText("page")).toBeTruthy();
  });

  it("should say chats will appear when there are none", () => {
    render(shell({ groups: [] }));

    expect(screen.getByText("Your chats appear here.")).toBeTruthy();
  });

  it("should show the viewer's name and initials", () => {
    render(shell());

    expect(screen.getByText("Alice Smith")).toBeTruthy();
    expect(screen.getByText("AS")).toBeTruthy();
  });

  it("should link to the hub only when the viewer also uses it", () => {
    const { rerender } = render(shell());
    expect(screen.queryByRole("link", { name: "Agent Hub" })).toBeNull();

    rerender(shell({ hubLink: true }));
    expect(screen.getByRole("link", { name: "Agent Hub" }).getAttribute("href")).toBe("/");
  });

  it("should take the sidebar out of reach when collapsed and bring it back from the page's toggle", () => {
    render(shell());

    expect(sidebar().hasAttribute("inert")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar().hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(sidebar().hasAttribute("inert")).toBe(false);
  });

  it("should start closed as a drawer and close with Escape or the backdrop when the screen is narrow", () => {
    narrow = true;
    render(shell());

    expect(sidebar().hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(sidebar().hasAttribute("inert")).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sidebar().hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(sidebar().hasAttribute("inert")).toBe(true);
  });

  it("should close the drawer when another chat opens on a narrow screen", () => {
    narrow = true;
    const { rerender } = render(shell());

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    rerender(shell({ activeId: "a" }));

    expect(sidebar().hasAttribute("inert")).toBe(true);
  });
});

describe("AssistantMarkdown", () => {
  it("should render headings as real headings when showing a document", () => {
    render(<AssistantMarkdown source={"# Title\n\n## Section\n\n### Detail"} document />);

    expect(screen.getByRole("heading", { level: 3, name: "Title" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Section" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 5, name: "Detail" })).toBeTruthy();
  });

  it("should render headings as bold lines when showing an answer", () => {
    render(<AssistantMarkdown source="# Title" />);

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Title").tagName).toBe("P");
  });

  it("should open allowed links in a new tab without an opener and leave others as text", () => {
    render(<AssistantMarkdown source="See [the guide](https://example.com/guide) or [this](javascript:alert(1))." />);

    const guide = screen.getByRole("link", { name: "the guide" });
    expect(guide.getAttribute("href")).toBe("https://example.com/guide");
    expect(guide.getAttribute("target")).toBe("_blank");
    expect(guide.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("should leave a message reference as text when the answer has one", () => {
    render(<AssistantMarkdown source="As in #1234 earlier" />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("As in #1234 earlier")).toBeTruthy();
  });

  it("should render code, emphasis and lists when the markdown has them", () => {
    const { container } = render(<AssistantMarkdown source={"Use `gradle` **now** and *soon*\n\n- one\n- two\n\n3. three\n\n```\nblock\n```"} />);

    expect(container.querySelector("code")?.textContent).toBe("gradle");
    expect(container.querySelector("strong")?.textContent).toBe("now");
    expect(container.querySelector("em")?.textContent).toBe("soon");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(container.querySelector("pre")?.textContent).toBe("block");
  });
});

describe("AssistantRefresh", () => {
  it.each(["assistant_conversation", "virtual_agent"])("should refresh the page once for a burst of %s events", async (type) => {
    vi.useFakeTimers();
    render(<AssistantRefresh />);

    hubHandlers.get(type)?.({});
    hubHandlers.get(type)?.({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("should refresh again when a later event follows a refresh", async () => {
    vi.useFakeTimers();
    render(<AssistantRefresh />);

    hubHandlers.get("virtual_agent")?.({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    hubHandlers.get("assistant_conversation")?.({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("should not refresh after the page has gone when an event was waiting", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<AssistantRefresh />);

    hubHandlers.get("virtual_agent")?.({});
    unmount();
    await vi.advanceTimersByTimeAsync(500);

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("ProductSelect", () => {
  it("should offer every product and report the one picked", () => {
    const onChange = vi.fn();
    render(<ProductSelect value="other" onChange={onChange} />);

    const select = screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement;
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toContain("No Fault Divorce");
    fireEvent.change(select, { target: { value: "nfdiv" } });

    expect(onChange).toHaveBeenCalledWith("nfdiv");
  });
});

describe("AssistantChatsPanel", () => {
  it("should link each chat on the virtual agent to the Assistant when it has some", async () => {
    const { AssistantChatsPanel } = await import("@/components/virtual-agents/AssistantChatsPanel");
    render(
      <AssistantChatsPanel chats={[{ id: "c1", title: "Listing story", product: "ccd", productLabel: "CCD", lastActiveAt: "2026-10-22T09:00:00.000Z" }]} />
    );

    expect(screen.getByRole("link", { name: "Listing story" }).getAttribute("href")).toBe("/assistant/c1");
    expect(screen.getByText("CCD")).toBeDefined();
  });

  it("should point to the Assistant when the virtual agent has no chats yet", async () => {
    const { AssistantChatsPanel } = await import("@/components/virtual-agents/AssistantChatsPanel");
    render(<AssistantChatsPanel chats={[]} />);

    expect(screen.getByRole("link", { name: "HMCTS Assistant" }).getAttribute("href")).toBe("/assistant");
  });
});
