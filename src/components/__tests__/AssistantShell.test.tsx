/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationLink } from "@/assistant/views";
import { ArtefactPanel } from "@/components/assistant/ArtefactPanel";
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

const SIDEBAR_KEY = "hmcts-assistant-sidebar-width";

function viewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

beforeEach(() => {
  narrow = false;
  viewport(1024);
  window.localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    // The sidebar asks a `max-width` question and the settings dialog a `min-width` one, so `narrow` answers both
    // only once the polarity is read off the query. A stub that answered the same for every query would put the
    // dialog in its narrow interface on a 1024px screen.
    value: (query: string) => ({
      matches: query.includes("min-width") ? !narrow : narrow,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    })
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

  it("should offer settings beside the viewer's name, and the appearance only from there", () => {
    render(shell({ theme: "dark" }));

    expect(screen.queryByRole("radiogroup", { name: "Appearance" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
  });

  it("should warn on the cog when a sign-in the viewer has to act on is missing", () => {
    render(shell({ connections: { kinds: ["github"], statuses: [], logins: [], unavailable: null } }));

    expect(screen.getByRole("button", { name: "Settings. GitHub needs your attention" })).toBeTruthy();
  });

  // The sidebar is transformed to slide the drawer in and out, which makes it the containing block of anything
  // `fixed` inside it, so the settings have to be rendered outside it or a narrow screen would clip them to the rail.
  it("should render the settings outside the sidebar when they are open", () => {
    render(shell());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(sidebar().contains(screen.getByRole("dialog"))).toBe(false);
  });

  // Escape closing both would take the cog the settings hand focus back to `inert` with the drawer, dropping focus.
  it("should close only the settings, not the drawer behind them, on Escape when the screen is narrow", () => {
    narrow = true;
    render(shell());
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const cog = screen.getByRole("button", { name: "Settings" });
    fireEvent.click(cog);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sidebar().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(cog);
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

describe("AssistantShell sidebar width", () => {
  function handle(): HTMLElement {
    return screen.getByRole("separator", { name: "Resize sidebar" });
  }

  function missingHandle(): HTMLElement | null {
    return screen.queryByRole("separator", { name: "Resize sidebar", hidden: true });
  }

  function drag(to: number, release = true): void {
    fireEvent.pointerDown(handle());
    fireEvent.pointerMove(window, { clientX: to });
    if (release) {
      fireEvent.pointerUp(window);
    }
  }

  it("should widen the sidebar when the handle is dragged towards the chat", () => {
    viewport(1600);
    render(shell());
    expect(handle().getAttribute("aria-valuenow")).toBe("272");

    drag(400);

    expect(handle().getAttribute("aria-valuenow")).toBe("400");
  });

  it("should narrow the sidebar when the handle is dragged back", () => {
    viewport(1600);
    render(shell());

    drag(260);

    expect(handle().getAttribute("aria-valuenow")).toBe("260");
  });

  it("should remember the width when the drag ends and not while the pointer is still moving", () => {
    viewport(1600);
    render(shell());

    fireEvent.pointerDown(handle());
    fireEvent.pointerMove(window, { clientX: 360 });
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull();

    fireEvent.pointerUp(window);

    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("360");
  });

  it("should give the dragged width back when the window is made small and then large again", () => {
    viewport(1600);
    render(shell());
    drag(460);

    // The window `resize` event is dispatched before the media queries are re-evaluated, so a handler that waits for
    // the screen to count as narrow has already missed it.
    viewport(700);
    fireEvent(window, new Event("resize"));
    viewport(1600);
    fireEvent(window, new Event("resize"));

    expect(handle().getAttribute("aria-valuenow")).toBe("460");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("460");
  });

  it("should fit a window too small for the dragged width without forgetting it", () => {
    viewport(1600);
    render(shell());
    drag(460);

    viewport(1000);
    fireEvent(window, new Event("resize"));

    expect(handle().getAttribute("aria-valuenow")).toBe("320");
    expect(handle().getAttribute("aria-valuemax")).toBe("320");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("460");
  });

  it("should follow the window's new size when it changes during a drag", () => {
    viewport(1600);
    render(shell());

    fireEvent.pointerDown(handle());
    fireEvent.pointerMove(window, { clientX: 460 });
    viewport(800);
    fireEvent(window, new Event("resize"));
    fireEvent.pointerMove(window, { clientX: 500 });
    fireEvent.pointerUp(window);

    // 800 less the chat's 360, the document panel covering the page at this width rather than taking a column.
    expect(handle().getAttribute("aria-valuemax")).toBe("440");
    expect(handle().getAttribute("aria-valuenow")).toBe("440");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("440");
  });

  it("should remember no width at all when the handle is pressed without being moved", () => {
    viewport(1600);
    render(shell());

    fireEvent.pointerDown(handle());
    fireEvent.pointerUp(window);

    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull();
  });

  it("should leave the remembered width alone when the handle is pressed without being moved", () => {
    window.localStorage.setItem(SIDEBAR_KEY, "460");
    viewport(1000);
    render(shell());

    fireEvent.pointerDown(handle());
    fireEvent.pointerUp(window);

    expect(handle().getAttribute("aria-valuenow")).toBe("320");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("460");
  });

  it("should keep back only the chat's room while the document panel covers the page instead of taking a column", () => {
    viewport(880);
    render(shell());

    expect(handle().getAttribute("aria-valuemax")).toBe("480");
    fireEvent.keyDown(handle(), { key: "End" });

    expect(handle().getAttribute("aria-valuenow")).toBe("480");
  });

  it("should stop following the pointer once the drag has ended", () => {
    viewport(1600);
    render(shell());

    drag(360);
    fireEvent.pointerMove(window, { clientX: 460 });

    expect(handle().getAttribute("aria-valuenow")).toBe("360");
  });

  it("should stop at its narrowest rather than collapse when dragged off the left of the page", () => {
    viewport(1600);
    render(shell());

    drag(-50);

    expect(handle().getAttribute("aria-valuenow")).toBe("240");
    expect(sidebar().hasAttribute("inert")).toBe(false);
  });

  it("should stop at its widest when dragged across the page", () => {
    viewport(1600);
    render(shell());

    drag(1500);

    expect(handle().getAttribute("aria-valuenow")).toBe("480");
    expect(handle().getAttribute("aria-valuemax")).toBe("480");
  });

  it("should keep the chat and a document panel their room when the window is too narrow for the widest sidebar", () => {
    viewport(1000);
    render(shell());

    drag(900);

    // The window, less the chat's narrowest 360 and the document panel's 320.
    expect(handle().getAttribute("aria-valuenow")).toBe("320");
  });

  it("should move the edge with the arrow keys and remember each width", () => {
    viewport(1600);
    render(shell());

    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(handle().getAttribute("aria-valuenow")).toBe("312");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("312");

    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(handle().getAttribute("aria-valuenow")).toBe("272");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("272");
  });

  it("should go to its narrowest with Home and its widest with End", () => {
    viewport(1600);
    render(shell());

    fireEvent.keyDown(handle(), { key: "End" });
    expect(handle().getAttribute("aria-valuenow")).toBe("480");

    fireEvent.keyDown(handle(), { key: "Home" });
    expect(handle().getAttribute("aria-valuenow")).toBe("240");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("240");
  });

  it("should leave the width alone when a key it does not handle is pressed", () => {
    render(shell());

    fireEvent.keyDown(handle(), { key: "Enter" });

    expect(handle().getAttribute("aria-valuenow")).toBe("272");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull();
  });

  it("should describe the handle as a vertical separator between its bounds", () => {
    viewport(1600);
    render(shell());

    expect(handle().getAttribute("aria-orientation")).toBe("vertical");
    expect(handle().getAttribute("aria-valuemin")).toBe("240");
    expect(handle().getAttribute("aria-valuemax")).toBe("480");
    expect(handle().tabIndex).toBe(0);
  });

  it("should start at the remembered width when the Assistant is opened again", () => {
    viewport(1600);
    window.localStorage.setItem(SIDEBAR_KEY, "430");

    render(shell());

    expect(handle().getAttribute("aria-valuenow")).toBe("430");
  });

  it("should start at its usual width when the remembered width is not a number", () => {
    window.localStorage.setItem(SIDEBAR_KEY, "as wide as before");

    render(shell());

    expect(handle().getAttribute("aria-valuenow")).toBe("272");
  });

  it("should bring a remembered width back in bounds when the window is smaller than it was", () => {
    viewport(1000);
    window.localStorage.setItem(SIDEBAR_KEY, "470");

    render(shell());

    expect(handle().getAttribute("aria-valuenow")).toBe("320");
  });

  it("should come back to the dragged width when the sidebar is expanded again", () => {
    viewport(1600);
    render(shell());
    drag(380);

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(missingHandle()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    expect(handle().getAttribute("aria-valuenow")).toBe("380");
  });

  it("should give the drawer its own width and no handle when the screen is narrow", () => {
    narrow = true;
    window.localStorage.setItem(SIDEBAR_KEY, "460");
    render(shell());
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    expect(missingHandle()).toBeNull();
    // jsdom lays nothing out, so the width the drawer is given is as far as this can be checked.
    expect(sidebar().style.width).toBe("272px");
  });

  it("should hold the document panel back from the chat's room as the sidebar is widened", () => {
    viewport(1600);
    render(
      <AssistantShell viewerName="Alice Smith" groups={[]} activeId={null}>
        <ArtefactPanel
          conversationId="22222222-2222-2222-2222-222222222222"
          artefact={{ title: "Story", markdown: "# Original", version: 2, updatedBy: "user" }}
          productLabel="CCD"
          save={async () => ({ ok: true, saved: true, version: 3 })}
          onClose={() => undefined}
          narrow={false}
        />
      </AssistantShell>
    );
    const document = () => screen.getByRole("separator", { name: "Resize document panel" });

    // The window, less the chat's narrowest 360 and the sidebar's width: the three always fit.
    expect(document().getAttribute("aria-valuemax")).toBe("968");

    drag(480);

    expect(document().getAttribute("aria-valuemax")).toBe("760");
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
      expect(() => render(<Unguarded source="anything" />)).toThrow("Markup has no case for the footnote block");
    } finally {
      logged.mockRestore();
      window.removeEventListener("error", swallow);
      vi.doUnmock("@/messages/markup");
      vi.resetModules();
    }
  });
});

describe("AssistantRefresh", () => {
  it.each(["assistant_conversation", "virtual_agent", "agent_skills"])("should refresh the page once for a burst of %s events", async (type) => {
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

  /**
   * The activity line is built in the browser from the transcript the conversation already streams, so a turn making
   * hundreds of tool calls costs no page reads at all. Wiring it through a refresh instead would make every one of
   * them a server render.
   */
  it("should never read the page again for a session's transcript, however much activity arrives", async () => {
    vi.useFakeTimers();
    render(<AssistantRefresh />);

    expect(hubHandlers.has("transcript")).toBe(false);
    for (let n = 0; n < 50; n += 1) {
      hubHandlers.get("transcript")?.({ agent_id: "a", last_id: String(n) });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("should refresh once when a cold chat reports its skills and its conversation together", async () => {
    vi.useFakeTimers();
    render(<AssistantRefresh />);

    hubHandlers.get("agent_skills")?.({});
    hubHandlers.get("assistant_conversation")?.({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
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
    render(<ProductSelect value="general" onChange={onChange} />);

    const select = screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement;
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toContain("No Fault Divorce (NFDIV)");
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
