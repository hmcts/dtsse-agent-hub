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
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN, BEN]} handlers={handlers} />);

    expect(marginNames()).toEqual(["Comment 1: Ben Reviewer", "Comment 2: Ann Reviewer", "Comment 3: Ann Reviewer"]);
    await waitFor(() => expect(replayed.built).toHaveLength(1));
  });

  it("should list a page's detached threads apart, under the others", () => {
    const threads = [thread("here"), thread("gone", { status: "detached" })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN]} handlers={handlers} />);

    expect(within(screen.getByRole("list", { name: "Comments no longer on the page" })).getAllByRole("article")).toHaveLength(1);
  });

  it("should list the pages with comments, and show the chosen one's threads", async () => {
    const threads = [thread("a"), thread("b", { pagePath: "/details" }), thread("c", { pagePath: "/details" })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN]} handlers={handlers} />);
    const pages = within(screen.getByRole("navigation", { name: "Filter comments" }));

    expect(pages.getAllByRole("button").map((button) => button.textContent)).toEqual(["/details2 comments", "/start1 comment"]);
    fireEvent.click(pages.getByRole("button", { name: /\/start/ }));

    expect(screen.getByRole("region", { name: "Comments on /start" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open live (opens in a new tab)" }).getAttribute("href")).toBe("/review/tok-one?path=%2Fstart");
  });

  it("should narrow the threads by reviewer, status and link, and say when none match", () => {
    const threads = [thread("a"), thread("b", { author: BEN, status: "resolved" })];
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN, BEN]} handlers={handlers} />);

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
    render(<CommentsView projectId="p1" threads={threads} links={project().links} people={[ANN]} handlers={handlers} />);
    await waitFor(() => expect(replayed.built).toHaveLength(1));

    fireEvent.click(screen.getAllByRole("article")[1] as HTMLElement);

    await waitFor(() => expect(replayed.built).toHaveLength(2));
    expect(replayed.built[0]?.destroyed).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/ui/feedback/projects/p1/threads/second/snapshot");
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
