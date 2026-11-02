/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcriptUrl, useLiveConversation } from "@/components/agents/useLiveConversation";
import { HubStreamProvider } from "@/components/live/HubStream";
import type { ThreadMessage } from "@/messages/direct-thread";
import type { ConversationItem, ConversationPage, TranscriptEntryView } from "@/transcripts/conversation";

const AGENT = "11111111-1111-1111-1111-111111111111";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

function message(id: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    kind: "direct",
    title: null,
    body: `message ${id}`,
    topics: [],
    tagged_agents: [],
    in_reply_to: null,
    target_agent_id: AGENT,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
    delivery: "queued",
    ...overrides
  };
}

function entry(id: string, overrides: Partial<TranscriptEntryView> = {}): TranscriptEntryView {
  return {
    id,
    key: `k${id}`,
    session_id: "session-1",
    role: "assistant",
    content: { text: `entry ${id}` },
    truncated: false,
    redacted: false,
    message_id: null,
    occurred_at: "2026-09-29T09:01:00.000Z",
    ...overrides
  };
}

function page(overrides: Partial<ConversationPage> = {}): ConversationPage {
  return { messages: [], entries: [], olderBefore: null, lastId: null, more: false, ...overrides };
}

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
  closed = false;
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function answers(...responses: Response[]) {
  const queue = [...responses];
  const fetch = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("no more answers");
    }
    return next;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function text(item: ConversationItem): string {
  if (item.type === "message") {
    return item.message.body;
  }
  if (item.type === "entry") {
    const content = item.entry.content as { text?: string };
    return content.text ?? "";
  }
  return item.question.id;
}

/** The hook's state as plain markup, so a test reads what a page built on it would have to show. */
function Harness({ initial, onReply, onMessage }: { initial: ConversationPage; onReply?: () => void; onMessage?: (message: ThreadMessage) => void }) {
  const live = useLiveConversation(AGENT, initial, { ...(onReply ? { onReply } : {}), ...(onMessage ? { onMessage } : {}) });
  return (
    <div>
      <ol aria-label="Conversation">
        {live.items.map((item) => (
          <li key={item.key}>{text(item)}</li>
        ))}
      </ol>
      {live.olderBefore === null ? null : (
        <button type="button" onClick={() => void live.loadEarlier()}>
          Load earlier
        </button>
      )}
      {live.error === null ? null : <p role="alert">{live.error}</p>}
      {live.signedOut ? <p role="status">signed out</p> : null}
    </div>
  );
}

function live(initial: ConversationPage = page(), handlers: { onReply?: () => void; onMessage?: (message: ThreadMessage) => void } = {}) {
  vi.stubGlobal("EventSource", FakeSource);
  return render(
    <HubStreamProvider>
      <Harness initial={initial} {...handlers} />
    </HubStreamProvider>
  );
}

describe("transcriptUrl", () => {
  it("should ask for the agent's entries around the cursor when given one", () => {
    expect(transcriptUrl(AGENT, { before: "41" })).toBe(`/api/ui/agents/${AGENT}/transcript?before=41`);
    expect(transcriptUrl(AGENT, { after: "7" })).toBe(`/api/ui/agents/${AGENT}/transcript?after=7`);
  });
});

describe("useLiveConversation live transcript", () => {
  it("should watch the agent on the stream when it mounts", () => {
    live();

    expect(FakeSource.last?.url).toContain(`agent=${AGENT}`);
  });

  it("should read the entries after the newest shown when the stream announces newer ones", async () => {
    const fetch = answers(Response.json(page({ entries: [entry("8", { content: { text: "live entry" } })], lastId: "8" })));
    live(page({ entries: [entry("7")], lastId: "7" }));

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "8" });
    });

    expect(fetch).toHaveBeenCalledWith(`/api/ui/agents/${AGENT}/transcript?after=7`, expect.anything());
    expect(screen.getByText("live entry")).toBeTruthy();

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "8" });
      FakeSource.last?.emit("transcript", { agent_id: "another-agent", last_id: "99" });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("should keep reading until it reaches the announced entry when one read is not enough", async () => {
    const fetch = answers(
      Response.json(page({ entries: [entry("1")], lastId: "1", more: true })),
      Response.json(page({ entries: [entry("2", { content: { text: "second" } })], lastId: "2" }))
    );
    live();

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "2" });
    });

    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      `/api/ui/agents/${AGENT}/transcript?after=0`,
      `/api/ui/agents/${AGENT}/transcript?after=1`
    ]);
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("should read once at a time and carry on to a newer entry announced during a read", async () => {
    let answer: (response: Response) => void = () => undefined;
    const first = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(Response.json(page({ entries: [entry("6", { content: { text: "newest" } })], lastId: "6" })));
    vi.stubGlobal("fetch", fetch);
    live(page({ lastId: "4" }));

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "5" });
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "6" });
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(Response.json(page({ entries: [entry("5")], lastId: "5" })));
    });

    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      `/api/ui/agents/${AGENT}/transcript?after=4`,
      `/api/ui/agents/${AGENT}/transcript?after=5`
    ]);
    expect(screen.getByText("newest")).toBeTruthy();
  });

  it("should stop reading when the announced entry has gone before it is read", async () => {
    const fetch = answers(Response.json(page({ lastId: "3" })));
    live(page({ lastId: "3" }));

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "9" });
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("should leave the entries for the next event to read when a read fails", async () => {
    const fetch = answers(new Response(null, { status: 500 }), Response.json(page({ entries: [entry("4", { content: { text: "later" } })], lastId: "4" })));
    live(page({ lastId: "3" }));

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "4" });
    });
    expect(screen.queryByText("later")).toBeNull();

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "4" });
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText("later")).toBeTruthy();
  });

  it("should end the session when a live read is answered 401", async () => {
    answers(new Response(null, { status: 401 }));
    live(page({ lastId: "3" }));

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "4" });
    });

    expect(FakeSource.last?.closed).toBe(true);
  });

  it("should tell the page of a reply only when a read brought an assistant entry", async () => {
    answers(
      Response.json(page({ entries: [entry("8", { role: "user", content: { text: "typed" } })], lastId: "8" })),
      Response.json(page({ entries: [entry("9")], lastId: "9" }))
    );
    const onReply = vi.fn();
    live(page({ lastId: "7" }), { onReply });

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "8" });
    });
    expect(onReply).not.toHaveBeenCalled();

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "9" });
    });
    expect(onReply).toHaveBeenCalledTimes(1);
  });
});

describe("useLiveConversation direct messages", () => {
  it("should add a live message and tell the page of it once, when it was not shown before", async () => {
    const onMessage = vi.fn();
    live(page({ messages: [message("1")] }), { onMessage });

    await act(async () => {
      FakeSource.last?.emit("direct", { message: message("1") });
      FakeSource.last?.emit("direct", { message: message("2", { body: "arrived" }) });
    });

    expect(screen.getByText("arrived")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(onMessage.mock.calls.map((call) => (call[0] as ThreadMessage).id)).toEqual(["2"]);
  });
});

describe("useLiveConversation earlier pages", () => {
  it("should load earlier entries and messages above, and stop offering more, when the start is reached", async () => {
    const fetch = answers(
      Response.json(
        page({
          messages: [message("1", { body: "older message", created_at: "2026-09-28T09:00:00.000Z" })],
          entries: [entry("2", { content: { text: "older entry" }, occurred_at: "2026-09-28T10:00:00.000Z" })]
        })
      )
    );
    live(page({ entries: [entry("3")], olderBefore: "3" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    });

    expect(fetch).toHaveBeenCalledWith(`/api/ui/agents/${AGENT}/transcript?before=3`, expect.anything());
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["older message", "older entry", "entry 3"]);
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
  });

  it("should say earlier activity could not be loaded when the read fails", async () => {
    answers(new Response(null, { status: 500 }));
    live(page({ entries: [entry("3")], olderBefore: "3" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("could not be loaded");
    expect(screen.getByRole("button", { name: "Load earlier" })).toBeTruthy();
  });

  it("should report the session ended rather than a failure when the read is answered 401", async () => {
    answers(new Response(null, { status: 401 }));
    live(page({ entries: [entry("3")], olderBefore: "3" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    });

    expect(screen.getByRole("status").textContent).toBe("signed out");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
