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

  it.each([
    ["an answer", false],
    ["a document", true]
  ])("should render a focusable, scrollable table with aligned column headers when %s has a pipe table", (_what, document) => {
    const { container } = render(
      <AssistantMarkdown source={"| left | centre | right |\n| :--- | :----: | -----: |\n| a | b | c |\n| d |"} document={document} />
    );

    const node = container.querySelector("table")!;
    expect(node.parentElement!.tabIndex).toBe(0);
    expect(node.parentElement!.className).toContain("overflow-x-auto");
    const headers = [...node.querySelectorAll("thead th")];
    expect(headers.map((header) => header.textContent)).toEqual(["left", "centre", "right"]);
    expect(headers.map((header) => header.getAttribute("scope"))).toEqual(["col", "col", "col"]);
    expect(headers.map((header) => header.className.match(/text-(?:left|center|right)/)![0])).toEqual(["text-left", "text-center", "text-right"]);
    // A short row is padded to the header's width, so the cells line up with the alignments by index.
    const rows = [...node.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["d", "", ""]
    ]);
  });

  it("should render a cell's own markup when a table cell holds a link or bold text", () => {
    const { container } = render(<AssistantMarkdown source={"| a | b |\n| - | - |\n| [docs](https://example.com/docs) | **bold** |"} />);

    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com/docs");
    expect(container.querySelector("td strong")!.textContent).toBe("bold");
  });

  it("should keep a code span's own spacing when it sits in a table cell", () => {
    const { container } = render(<AssistantMarkdown source={"| cmd |\n| --- |\n| `git log  --oneline` |"} />);

    const span = container.querySelector("td code")!;
    expect(span.textContent).toBe("git log  --oneline");
    // No stylesheet runs here, so the classes are what carry it: the cell's text collapses its pipe padding, the span does not.
    expect(span.className).toContain("whitespace-pre-wrap");
    expect(container.querySelector("table")!.className).toContain("whitespace-normal");
  });

  it("should keep the author's pipes as text, losing nothing, when a table's delimiter row is missing", () => {
    const { container } = render(<AssistantMarkdown source={"| a | b |\n| c | d |"} />);

    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toBe("| a | b |\n| c | d |");
  });

  it("should keep an over-wide row's words in its last cell when a cell holds an unescaped pipe", () => {
    const { container } = render(<AssistantMarkdown source={"| a | b |\n| - | - |\n| one | two | three |"} />);

    // The overflow stays in the last cell as the author wrote it, pipes and all, rather than being truncated away.
    const cells = [...container.querySelectorAll("tbody td")].map((cell) => cell.textContent);
    expect(cells).toEqual(["one", "two | three"]);
  });

  it("should fail loudly rather than render nothing when a block type has no case", async () => {
    vi.doMock("@/messages/markup", async (original) => ({
      ...(await original<typeof import("@/messages/markup")>()),
      parseMarkup: () => [{ type: "footnote" }]
    }));
    vi.resetModules();
    const { AssistantMarkdown: Unguarded } = await import("@/components/assistant/AssistantMarkdown");
    // React re-throws through an error event and logs the render it gave up on; both are the point of the test.
    const swallow = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", swallow);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(() => render(<Unguarded source="anything" />)).toThrow("AssistantMarkdown has no case for the footnote block");
    } finally {
      logged.mockRestore();
      window.removeEventListener("error", swallow);
      vi.doUnmock("@/messages/markup");
      vi.resetModules();
    }
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
