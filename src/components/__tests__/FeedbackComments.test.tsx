/**
 * @vitest-environment jsdom
 */
import { gzipSync } from "node:zlib";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsView, type ThreadHandlers } from "@/components/feedback/dev/CommentsView";
import { findAnchor, type Highlight, SnapshotView } from "@/components/feedback/dev/SnapshotView";
import { ANN, BEN, project, thread } from "./feedback-fixtures";

/** What the fake replayer builds in its frame: the page the snapshots are of. */
const replayed = vi.hoisted(() => ({ html: "", built: [] as { config: Record<string, unknown>; paused: number[]; destroyed: boolean }[] }));

vi.mock("@rrweb/replay", () => ({
  Replayer: class {
    iframe: HTMLIFrameElement;
    record: { config: Record<string, unknown>; paused: number[]; destroyed: boolean };
    constructor(_events: unknown[], config: { root: HTMLElement } & Record<string, unknown>) {
      this.iframe = document.createElement("iframe");
      config.root.appendChild(this.iframe);
      const frame = this.iframe.contentWindow as Window & typeof globalThis;
      frame.Element.prototype.scrollIntoView = () => undefined;
      (this.iframe.contentDocument as Document).body.innerHTML = replayed.html;
      this.record = { config, paused: [], destroyed: false };
      replayed.built.push(this.record);
    }
    getMetaData() {
      return { startTime: 0, endTime: 40, totalTime: 40 };
    }
    pause(at: number) {
      this.record.paused.push(at);
    }
    destroy() {
      this.record.destroyed = true;
    }
  }
}));

const SNAPSHOT = gzipSync(
  JSON.stringify([
    { type: 4, timestamp: 1, data: { width: 1000, height: 800 } },
    { type: 2, timestamp: 2, data: {} }
  ])
);

function fetchSnapshots(missing: readonly string[] = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const snapshot = /threads\/([^/]+)\/snapshot$/.exec(url);
    if (snapshot !== null) {
      return missing.includes(snapshot[1] as string) ? new Response(null, { status: 404 }) : Response.json({ url: `https://blob.example.com/${snapshot[1]}` });
    }
    return new Response(SNAPSHOT);
  });
}

const handlers: ThreadHandlers = { reply: vi.fn(async () => null), status: vi.fn(async () => null) };

beforeEach(() => {
  replayed.html = "";
  replayed.built = [];
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchSnapshots());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = (y: number) => ({ selector: `#y${y}`, text: "", tag: "p", rect: { x: 0, y, width: 50, height: 10 }, viewport: { width: 1000, height: 800 } });

function marginNames(): string[] {
  return within(screen.getByRole("list", { name: "Comments on this page" }))
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent ?? "");
}

describe("CommentsView", () => {
  it("should lay a page's cards down the margin in the order their elements are down the page", async () => {
    const threads = [thread("low", { anchor: at(700) }), thread("top", { anchor: at(20), author: BEN }), thread("mid", { anchor: at(300) })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN, BEN]} handlers={handlers} initialMode="page" />);

    expect(marginNames()).toEqual(["Comment 1: Ben Reviewer", "Comment 2: Ann Reviewer", "Comment 3: Ann Reviewer"]);
    await waitFor(() => expect(replayed.built).toHaveLength(1));
  });

  it("should list a page's detached threads apart, under the others", () => {
    const threads = [thread("here"), thread("gone", { status: "detached" })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN]} handlers={handlers} initialMode="page" />);

    expect(within(screen.getByRole("list", { name: "Comments no longer on the page" })).getAllByRole("article")).toHaveLength(1);
  });

  it("should list the pages with comments, and show the chosen one's threads", async () => {
    const threads = [thread("a"), thread("b", { pagePath: "/details" }), thread("c", { pagePath: "/details" })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN]} handlers={handlers} initialMode="page" />);
    const pages = within(screen.getByRole("navigation", { name: "Filter comments" }));

    expect(pages.getAllByRole("button").map((button) => button.textContent)).toEqual(["/details2 comments", "/start1 comment"]);
    fireEvent.click(pages.getByRole("button", { name: /\/start/ }));

    expect(screen.getByRole("region", { name: "Comments on /start" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open live (opens in a new tab)" }).getAttribute("href")).toBe("/review/tok-one?path=%2Fstart");
  });

  it("should narrow the threads by reviewer, status and link, and say when none match", () => {
    const threads = [thread("a"), thread("b", { author: BEN, status: "resolved" })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN, BEN]} handlers={handlers} initialMode="page" />);

    fireEvent.change(screen.getByLabelText("Reviewer"), { target: { value: "ben" } });
    expect(marginNames()).toEqual(["Comment 1: Ben Reviewer"]);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "open" } });
    expect(screen.getByText("No comments match these filters.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "l1" } });
    expect(marginNames()).toEqual(["Comment 1: Ben Reviewer"]);
  });

  it("should say there are no comments yet on a project without any", () => {
    render(<CommentsView projectId="p1" threads={[]} links={project().links} people={[]} handlers={handlers} />);

    expect(screen.getByText(/No comments yet/)).toBeTruthy();
  });

  it("should show the chosen card's own snapshot and mark it as the focused one", async () => {
    replayed.html = '<p id="first">text of first</p><p id="second">text of second</p>';
    const threads = [thread("first", { anchor: { ...at(10), selector: "#first" } }), thread("second", { anchor: { ...at(90), selector: "#second" } })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN]} handlers={handlers} initialMode="page" />);
    await waitFor(() => expect(replayed.built).toHaveLength(1));

    fireEvent.click(within(screen.getAllByRole("article")[1] as HTMLElement).getByRole("button", { name: /^Comment 2:/ }));

    await waitFor(() => expect(replayed.built).toHaveLength(2));
    expect(replayed.built[0]?.destroyed).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/ui/feedback/projects/p1/threads/second/snapshot");
  });
});

describe("CommentsView's list of all comments", () => {
  const linkAnchor = { ...at(40), tag: "a", text: "Start now" };

  it("should show every comment at first, under the title of the page it is on", () => {
    const threads = [
      thread("a", { pageTitle: "Make a claim", anchor: linkAnchor }),
      thread("b", { pagePath: "/details", pageTitle: null }),
      thread("c", { pagePath: "/details", pageTitle: null, status: "resolved" })
    ];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN]} handlers={handlers} />);

    expect(screen.getByRole("button", { name: "All comments" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: /^\/details/ })).toBeTruthy();
    const start = within(screen.getByRole("region", { name: /^Make a claim/ }));
    expect(start.getByText(/\/start · 1 comment/)).toBeTruthy();
    expect(start.getByText("On the “Start now” link")).toBeTruthy();
    expect(start.getByText("Comment a")).toBeTruthy();
    expect(screen.getAllByRole("article", { name: /^Comment by/ })).toHaveLength(3);
    expect(within(screen.getByRole("region", { name: /^\/details/ })).getByText("Resolved")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Filter comments" })).queryByText("Pages")).toBeNull();
  });

  it("should pick out the people a comment names, and sum up its replies", () => {
    const at10 = "2026-11-10T10:00:00.000Z";
    const threads = [
      thread("a", {
        comments: [
          { id: "c1", author: ANN, body: "Ask @Ben Reviewer about this", createdAt: at10, mentions: ["ben"] },
          { id: "c2", author: BEN, body: "Looking now", createdAt: at10, mentions: [] },
          { id: "c3", author: BEN, body: "x".repeat(130), createdAt: at10, mentions: [] }
        ]
      })
    ];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN, BEN]} handlers={handlers} />);

    expect(screen.getByText("@Ben Reviewer").tagName).toBe("STRONG");
    expect(screen.getByText(/^2 replies · latest from/).textContent).toContain(`${"x".repeat(120)}…`);
  });

  it("should open a comment on its page, as the one chosen, from View on page", async () => {
    const threads = [thread("a"), thread("b", { pagePath: "/details", pageTitle: "Your details", author: BEN })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN, BEN]} handlers={handlers} />);

    const details = within(screen.getByRole("region", { name: /^Your details/ }));
    fireEvent.click(details.getByRole("button", { name: "View on page and reply" }));

    expect(screen.getByRole("button", { name: "Page by page" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Comments on Your details" })).toBeTruthy();
    expect(marginNames()).toEqual(["Comment 1: Ben Reviewer"]);
    expect(
      within(screen.getByRole("navigation", { name: "Filter comments" }))
        .getByRole("button", { name: /Your details/ })
        .getAttribute("aria-current")
    ).toBe("page");
    await waitFor(() => expect(replayed.built).toHaveLength(1));
  });

  it("should name each page's link when the project has more than one", () => {
    const two = project({
      links: [...project().links, { ...(project().links[0] as (typeof project.prototype)["links"][number]), id: "l2", label: "Round 2", token: "tok-two" }]
    } as never).links;
    render(<CommentsView projectId="p1" threads={[thread("a", { linkId: "l2" })]} links={two} people={[ANN]} handlers={handlers} />);

    expect(screen.getByText(/Round 2 · 1 comment/)).toBeTruthy();
  });

  it("should open on the thread a link names, on its page, and ignore one it does not have", async () => {
    const threads = [thread("a"), thread("b", { pagePath: "/details", pageTitle: "Your details", author: BEN })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN, BEN]} handlers={handlers} initialThread="b" />);

    expect(screen.getByRole("region", { name: "Comments on Your details" })).toBeTruthy();
    await waitFor(() => expect(replayed.built).toHaveLength(1));
    cleanup();

    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN, BEN]} handlers={handlers} initialThread="gone" />);
    expect(screen.getByRole("button", { name: "All comments" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("should go back to the list from Page by page", () => {
    render(<CommentsView projectId="p1" threads={[thread("a")]} links={project().links} people={[ANN]} handlers={handlers} initialMode="page" />);

    fireEvent.click(screen.getByRole("button", { name: "All comments" }));

    expect(screen.getAllByRole("article", { name: /^Comment by/ })).toHaveLength(1);
  });
});

describe("CommentsView's choosing, themes and refining", () => {
  function choosing(more: Partial<ThreadHandlers> = {}) {
    return {
      reply: vi.fn(async () => null),
      status: vi.fn(async () => null as string | null),
      theme: vi.fn(async () => null as string | null),
      refine: vi.fn(async () => null as string | null),
      ...more
    };
  }

  const threads = () => [
    thread("a", { theme: "Fees", jiraKeys: ["PCS-1"], refinedIn: "conv-1" }),
    thread("b", { pagePath: "/details", pageTitle: "Your details", author: BEN }),
    thread("c", { pagePath: "/details", pageTitle: "Your details", status: "resolved", theme: "Fees" })
  ];

  it("should let nobody choose comments without the theme handler", () => {
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={handlers} />);

    expect(screen.queryByRole("checkbox", { name: /Select all/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /^Choose the comment/ })).toBeNull();
  });

  it("should show a thread's theme, its Jira issues, and the way to the viewer's own refining chat", () => {
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={choosing()} />);
    expect(screen.queryByText("Theme: Fees")).toBeNull();
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "page" } });

    const first = within(screen.getByText("Comment a").closest("article") as HTMLElement);
    expect(first.getByText("Theme: Fees")).toBeTruthy();
    expect(first.getByText("Jira PCS-1")).toBeTruthy();
    expect(first.getByRole("link", { name: "Refined in your chat" }).getAttribute("href")).toBe("/assistant/conv-1");
  });

  it("should choose all shown, then give the chosen a theme and clear the box", async () => {
    const chosen = choosing();
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={chosen} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all 3 shown" }));
    expect(screen.getByText("3 comments chosen")).toBeTruthy();
    const box = screen.getByLabelText("Theme for the chosen comments") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "Court fees" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Set theme" })));

    expect(chosen.theme).toHaveBeenCalledWith(["a", "b", "c"], "Court fees");
    expect(box.value).toBe("");
    expect(box.placeholder).toBe("Mixed themes: type one to give them all");
  });

  it("should show the theme the chosen comments share, and offer Set theme only once it is changed", () => {
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={choosing()} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Choose all 2 comments in Fees" }));
    const box = screen.getByLabelText("Theme for the chosen comments") as HTMLInputElement;
    expect(box.value).toBe("Fees");
    expect((screen.getByRole("button", { name: "Set theme" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(box, { target: { value: "Court fees" } });
    expect((screen.getByRole("button", { name: "Set theme" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("checkbox", { name: /^Choose the comment by Ben Reviewer/ }));
    expect(box.value).toBe("");
    expect(box.placeholder).toBe("Mixed themes: type one to give them all");
  });

  it("should remove the theme of the chosen, resolve the open ones among them, and say why one failed", async () => {
    const chosen = choosing({ status: vi.fn(async () => "that project is archived") });
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={chosen} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /^Choose the comment by Ann Reviewer: Comment a/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Choose the comment by Ben Reviewer/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove theme" })));
    expect(chosen.theme).toHaveBeenCalledWith(["a", "b"], null);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resolve" })));
    expect(chosen.status).toHaveBeenCalledTimes(1);
    expect(chosen.status).toHaveBeenCalledWith("a", "resolved");
    expect(screen.getByRole("alert").textContent).toBe("that project is archived");
  });

  it("should resolve every open one chosen when none fails, and offer neither when there is nothing to do", async () => {
    const chosen = choosing();
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={chosen} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /^Choose the comment by Ben Reviewer/ }));
    expect((screen.getByRole("button", { name: "Remove theme" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resolve" })));
    expect(chosen.status).toHaveBeenCalledWith("b", "resolved");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Choose the comment by Ben Reviewer/ }));
    expect(screen.queryByRole("region", { name: "Chosen comments" })).toBeNull();
  });

  it("should refine the chosen with the Assistant, and clear the choice from Clear", async () => {
    const chosen = choosing();
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={chosen} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /^Choose the comment by Ben Reviewer/ }));
    expect(screen.getByText(/drafts one Jira story for each theme/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refine with Assistant" })));
    expect(chosen.refine).toHaveBeenCalledWith(["b"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/chosen$/)).toBeNull();
  });

  it("should not offer refining without its handler, nor more comments than one refinement takes", () => {
    const many = Array.from({ length: 41 }, (_, index) => thread(`t${index}`));
    const { rerender } = render(<CommentsView projectId="p1" threads={many} links={project().links} people={[ANN]} handlers={choosing()} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all 41 shown" }));
    expect((screen.getByRole("button", { name: "Refine with Assistant" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Choose at most 40 comments to refine at once.")).toBeTruthy();

    rerender(<CommentsView projectId="p1" threads={many} links={project().links} people={[ANN]} handlers={choosing({ refine: undefined })} />);
    expect(screen.queryByRole("button", { name: "Refine with Assistant" })).toBeNull();
  });

  it("should open grouped by theme once comments have themes, and by page while none has", () => {
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={choosing()} />);
    expect((screen.getByLabelText("Group by") as HTMLSelectElement).value).toBe("theme");
    cleanup();

    render(<CommentsView projectId="p1" threads={[thread("a"), thread("b")]} links={project().links} people={[ANN]} handlers={choosing()} />);
    expect((screen.getByLabelText("Group by") as HTMLSelectElement).value).toBe("page");
  });

  it("should choose every comment in a theme at once, and let them go again", () => {
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={choosing()} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Choose all 2 comments in Fees" }));
    expect(screen.getByText("2 comments chosen")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Select all 3 shown" }) as HTMLInputElement).indeterminate).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "Choose all 2 comments in Fees" }));
    expect(screen.queryByRole("region", { name: "Chosen comments" })).toBeNull();
  });

  it("should refine a whole theme from its heading, and say why when that was refused", async () => {
    const chosen = choosing({ refine: vi.fn(async () => "Connect GitHub and Claude to start chatting") });
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={chosen} />);

    expect(screen.queryByRole("button", { name: "Refine this theme: No theme" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refine this theme: Fees" })));

    expect(chosen.refine).toHaveBeenCalledWith(["c", "a"]);
    expect(screen.getByRole("alert").textContent).toBe("Connect GitHub and Claude to start chatting");
  });

  it("should group the comments by theme, those with none last, saying which page each is on", () => {
    render(<CommentsView projectId="p1" threads={threads()} links={project().links} people={[ANN, BEN]} handlers={choosing()} />);

    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "theme" } });

    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Fees2 comments", "No theme1 comment"]);
    expect(screen.getByText("On Your details, the text “text of c”")).toBeTruthy();
  });
});

describe("SnapshotView", () => {
  it("should rebuild the snapshot in a frame with scripts off, every event applied, and outline the element", async () => {
    replayed.html = '<p id="t1">text of t1</p>';
    const seen: (Highlight | null)[] = [];
    render(<SnapshotView projectId="p1" thread={thread("t1")} onHighlight={(highlight) => seen.push(highlight)} />);

    await waitFor(() => expect(screen.getByTestId("snapshot-highlight")).toBeTruthy());
    const built = replayed.built[0];
    expect(built?.config).toMatchObject({ UNSAFE_replayCanvas: false, mouseTail: false, triggerFocus: false });
    expect(built?.paused).toEqual([41]);
    // The highlight is reported from an effect, which can run after the outline is already on screen.
    await waitFor(() => expect(seen.at(-1)).toMatchObject({ approximate: false }));
    expect(screen.getByRole("status").textContent).toContain("with the element outlined");
  });

  it("should outline where the element was when it is not in the snapshot", async () => {
    replayed.html = "<p>something else</p>";
    render(<SnapshotView projectId="p1" thread={thread("t1")} />);

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("could not be found in the snapshot"));
    expect(screen.getByTestId("snapshot-highlight").className).toContain("border-dashed");
  });

  it("should say when a thread has no snapshot, without asking for one", () => {
    render(<SnapshotView projectId="p1" thread={thread("t1", { snapshotBlob: null })} />);

    expect(screen.getByRole("status").textContent).toBe("No snapshot was taken with this comment.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should say when the hub has no snapshot for it", async () => {
    vi.stubGlobal("fetch", fetchSnapshots(["t1"]));
    render(<SnapshotView projectId="p1" thread={thread("t1")} />);

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No snapshot was taken with this comment."));
  });

  it("should say when the snapshot could not be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 }))
    );
    render(<SnapshotView projectId="p1" thread={thread("t1")} />);

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The snapshot could not be shown: the snapshot could not be read."));
  });

  it("should say when the snapshot could not be downloaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/") ? Response.json({ url: "https://blob.example.com/x" }) : new Response(null, { status: 403 })
      )
    );
    render(<SnapshotView projectId="p1" thread={thread("t1")} />);

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("could not be downloaded"));
  });

  it("should scale the page to the width it is given", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 500 });
    try {
      replayed.html = '<p id="t1">text of t1</p>';
      const { container } = render(<SnapshotView projectId="p1" thread={thread("t1")} />);
      await act(async () => undefined);

      expect((container.firstElementChild as HTMLElement).style.height).toBe("400px");
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });
});

describe("findAnchor", () => {
  function doc(html: string): Document {
    const made = document.implementation.createHTMLDocument("x");
    made.body.innerHTML = html;
    return made;
  }

  it("should find the element by its selector", () => {
    expect(findAnchor(doc('<p id="a">one</p>'), { selector: "#a", tag: "p", text: "" })?.textContent).toBe("one");
  });

  it("should fall back to its tag and the start of its text, including when the selector cannot be parsed", () => {
    const page = doc("<p>one</p><p>Save and continue</p>");

    expect(findAnchor(page, { selector: "#gone", tag: "p", text: "Save and" })?.textContent).toBe("Save and continue");
    expect(findAnchor(page, { selector: "p:::", tag: "p", text: "one" })?.textContent).toBe("one");
    expect(findAnchor(page, { selector: "#gone", tag: "p", text: " " })).toBeNull();
    expect(findAnchor(page, { selector: "#gone", tag: "button", text: "one" })).toBeNull();
  });
});
