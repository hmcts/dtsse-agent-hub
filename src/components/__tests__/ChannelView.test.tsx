/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arrivalOf, ChannelView, feedUrl } from "@/components/feed/ChannelView";
import { ANNOUNCE_AFTER_MS } from "@/components/live/Announcer";
import { HubStreamProvider } from "@/components/live/HubStream";
import { SessionEndedBanner } from "@/components/live/SessionEnded";
import type { ApiMessage } from "@/messages/shape";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

class FakeSource {
  static last: FakeSource | undefined;
  readyState = 1;
  readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {}
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

function post(id: string, overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id,
    kind: "post",
    title: null,
    body: `post ${id}`,
    topics: ["a"],
    in_reply_to: null,
    target_agent_id: null,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "agent", agent_id: "agent-1", agent_name: "pcs", owner_name: "Alice", owner_email: null },
    ...overrides
  };
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("feedUrl", () => {
  it("should ask for the page before an id on the view's topics", () => {
    expect(feedUrl(["a", "b"], "all", "10")).toBe("/api/ui/feed?topics=a%2Cb&mode=all&before=10");
  });

  it("should ask for the page before an id of every post when the view is over everything", () => {
    expect(feedUrl("everything", "any", "10")).toBe("/api/ui/feed?everything=1&before=10");
  });
});

describe("ChannelView", () => {
  it("should watch the view's topics and show a live post when one arrives", async () => {
    render(
      <HubStreamProvider>
        <ChannelView topics={["a"]} match="any" initial={{ messages: [post("1")], olderBefore: null }} />
      </HubStreamProvider>
    );

    expect(FakeSource.last?.url).toBe("/api/ui/stream?topics=a&mode=any");
    await act(async () => {
      FakeSource.last?.emit("post", { message: post("2") });
    });

    expect(screen.getByText("post 2")).toBeTruthy();
  });

  it("should collapse a reply under its parent when both are shown", () => {
    render(<ChannelView topics={["a"]} match="any" initial={{ messages: [post("1"), post("2", { in_reply_to: "1", body: "a reply" })], olderBefore: null }} />);

    expect(screen.getByText("1 reply")).toBeTruthy();
  });

  it("should load the older page above the shown posts when asked", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messages: [post("3")], olderBefore: null })));
    vi.stubGlobal("fetch", fetch);
    render(<ChannelView topics={["a"]} match="any" initial={{ messages: [post("5")], olderBefore: "5" }} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older posts" }));
    });

    expect(fetch).toHaveBeenCalledWith("/api/ui/feed?topics=a&mode=any&before=5", expect.anything());
    const bodies = screen.getAllByText(/^post \d$/).map((element) => element.textContent);
    expect(bodies).toEqual(["post 3", "post 5"]);
    expect(screen.queryByRole("button", { name: "Load older posts" })).toBeNull();
  });

  it("should say older posts could not be loaded when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 }))
    );
    render(<ChannelView topics={["a"]} match="any" initial={{ messages: [post("5")], olderBefore: "5" }} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older posts" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("could not be loaded");
  });

  it("should watch every post, load older ones and offer no composer when the view is over everything", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messages: [post("3", { topics: ["b"] })], olderBefore: null })));
    vi.stubGlobal("fetch", fetch);
    render(
      <HubStreamProvider>
        <ChannelView topics="everything" match="any" initial={{ messages: [post("5")], olderBefore: "5" }} post={vi.fn()} />
      </HubStreamProvider>
    );

    expect(FakeSource.last?.url).toBe("/api/ui/stream?everything=1");
    expect(screen.queryByPlaceholderText("Write a post")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older posts" }));
    });

    expect(fetch).toHaveBeenCalledWith("/api/ui/feed?everything=1&before=5", expect.anything());
    expect(screen.getByText("post 3")).toBeTruthy();
  });

  it("should say nothing is posted anywhere yet when the view over everything is empty", () => {
    render(<ChannelView topics="everything" match="any" initial={{ messages: [], olderBefore: null }} />);

    expect(screen.getByText("Nothing has been posted yet.")).toBeTruthy();
  });

  it("should offer to sign in again and show the banner when loading older posts is refused for want of a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "sign in first" }), { status: 401 }))
    );
    render(
      <HubStreamProvider>
        <SessionEndedBanner />
        <ChannelView topics={["a"]} match="any" initial={{ messages: [post("5")], olderBefore: "5" }} />
      </HubStreamProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older posts" }));
    });

    expect(screen.getByRole("status").textContent).toContain("Your session has ended");
    expect(screen.getByRole("alert").textContent).toContain("Your session has ended");
    expect(screen.getAllByRole("link", { name: "Sign in again" })).toHaveLength(2);
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it("should say nothing is posted yet when the view is empty", () => {
    render(<ChannelView topics={["a"]} match="any" initial={{ messages: [], olderBefore: null }} />);

    expect(screen.getByText("Nothing has been posted on these topics yet.")).toBeTruthy();
  });

  it("should show the composer only when a post action is given, and add a reply once it is posted", async () => {
    const action = vi.fn(async () => ({ ok: true as const, message: post("9", { in_reply_to: "1", body: "my reply" }) }));
    const { rerender } = render(<ChannelView topics={["a"]} match="any" initial={{ messages: [post("1")], olderBefore: null }} />);
    expect(screen.queryByRole("form", { name: "New post" })).toBeNull();

    rerender(<ChannelView topics={["a"]} match="any" initial={{ messages: [post("1")], olderBefore: null }} post={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply to post 1" }));
    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "my reply" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Post" }));
    });

    expect(action).toHaveBeenCalledWith(expect.objectContaining({ inReplyTo: "1" }));
    expect(screen.getByText("1 reply")).toBeTruthy();
    expect(screen.queryByText("Replying to #1")).toBeNull();
  });

  it("should drop the reply target when the reply is cancelled", () => {
    render(<ChannelView topics={["a"]} match="any" initial={{ messages: [post("1")], olderBefore: null }} post={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Reply to post 1" }));
    expect(screen.getByText("Replying to #1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));

    expect(screen.queryByText("Replying to #1")).toBeNull();
  });
});

describe("arrivalOf", () => {
  it("should name the agent and the post's topics when an agent posts", () => {
    expect(arrivalOf(post("1", { topics: ["a", "b"] }))).toBe("New post from @pcs on #a, #b");
  });

  it("should name the person when they posted from the UI with no topics", () => {
    expect(arrivalOf(post("1", { topics: [], author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null } }))).toBe(
      "New post from Alice"
    );
  });
});

describe("ChannelView announcements", () => {
  function arrivals(): string {
    return screen.getByTestId("arrivals").textContent ?? "";
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should keep the feed itself out of the live region when rendering", () => {
    render(<ChannelView topics={["a"]} match="any" initial={{ messages: [post("1")], olderBefore: null }} />);

    expect(screen.getByRole("list", { name: "Posts" }).getAttribute("aria-live")).toBeNull();
    expect(screen.getByTestId("arrivals").getAttribute("aria-live")).toBe("polite");
    expect(arrivals()).toBe("");
  });

  it("should announce a live post by its author and topic when one arrives", async () => {
    render(
      <HubStreamProvider>
        <ChannelView topics={["a"]} match="any" initial={{ messages: [post("1")], olderBefore: null }} />
      </HubStreamProvider>
    );

    await act(async () => {
      FakeSource.last?.emit("post", { message: post("2") });
    });
    expect(arrivals()).toBe("");
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
    });

    expect(arrivals()).toBe("New post from @pcs on #a");
  });

  it("should announce a count when several posts arrive together, and ignore one already shown", async () => {
    render(
      <HubStreamProvider>
        <ChannelView topics={["a"]} match="any" initial={{ messages: [post("1")], olderBefore: null }} />
      </HubStreamProvider>
    );

    await act(async () => {
      FakeSource.last?.emit("post", { message: post("1") });
      FakeSource.last?.emit("post", { message: post("2") });
      FakeSource.last?.emit("post", { message: post("3") });
      FakeSource.last?.emit("post", { message: post("4") });
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
    });

    expect(arrivals()).toBe("3 new posts");
  });

  it("should announce nothing when older posts are loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [post("3"), post("4")], olderBefore: null })))
    );
    render(<ChannelView topics={["a"]} match="any" initial={{ messages: [post("5")], olderBefore: "5" }} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older posts" }));
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
    });

    expect(screen.getByText("post 3")).toBeTruthy();
    expect(arrivals()).toBe("");
  });
});

describe("ChannelView reply cancelling", () => {
  it("should leave reply mode and focus the post's reply button when Escape is pressed in the composer", () => {
    render(<ChannelView topics={["a"]} match="any" initial={{ messages: [post("1")], olderBefore: null }} post={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Reply to post 1" }));
    fireEvent.keyDown(screen.getByPlaceholderText("Write a post"), { key: "Escape" });

    expect(screen.queryByText("Replying to #1")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply to post 1" }));
  });
});
