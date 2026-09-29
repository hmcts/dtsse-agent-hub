/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectThread, mayMessage } from "@/components/agents/DirectThread";
import { HubStreamProvider } from "@/components/live/HubStream";
import type { ThreadMessage } from "@/messages/direct-thread";

const AGENT = "11111111-1111-1111-1111-111111111111";

function message(id: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    kind: "direct",
    title: null,
    body: `message ${id}`,
    topics: [],
    in_reply_to: null,
    target_agent_id: AGENT,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
    delivery: "queued",
    ...overrides
  };
}

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sessionAnswers(status: number) {
  const fetch = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("mayMessage", () => {
  it.each([
    ["owner", true],
    ["write", true],
    ["read", false]
  ] as const)("should decide %s may message: %s", (access, expected) => {
    expect(mayMessage(access)).toBe(expected);
  });
});

describe("DirectThread", () => {
  it.each(["owner", "write"] as const)("should show the composer when the viewer has %s access", (access) => {
    render(<DirectThread agentId={AGENT} access={access} initial={[]} send={vi.fn()} />);

    expect(screen.getByRole("form", { name: "Message this agent" })).toBeTruthy();
    expect(screen.queryByTestId("read-only-thread")).toBeNull();
  });

  it("should hide the composer and say why when the viewer has read access only", () => {
    render(<DirectThread agentId={AGENT} access="read" initial={[message("1")]} send={vi.fn()} />);

    expect(screen.queryByRole("form", { name: "Message this agent" })).toBeNull();
    expect(screen.getByTestId("read-only-thread").textContent).toContain("read access");
    expect(screen.getByText("message 1")).toBeTruthy();
  });

  it("should show each message's delivery state and nothing for a reply with no target when rendering the thread", () => {
    render(
      <DirectThread
        agentId={AGENT}
        access="read"
        initial={[
          message("1", { delivery: "delivered" }),
          message("2", {
            target_agent_id: null,
            delivery: null,
            author: { type: "agent", agent_id: AGENT, agent_name: "pcs", owner_name: "Bob", owner_email: null }
          })
        ]}
        send={vi.fn()}
      />
    );

    expect(screen.getByText("delivered")).toBeTruthy();
    expect(screen.getByText("replied")).toBeTruthy();
    expect(screen.getAllByText(/queued|delivered|expired/)).toHaveLength(1);
  });

  it("should add the sent message to the thread and clear the box when sending succeeds", async () => {
    const send = vi.fn(async () => ({ ok: true as const, message: message("9", { body: "hello agent" }) }));
    render(<DirectThread agentId={AGENT} access="owner" initial={[]} send={send} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello agent" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Message this agent" }));
    });

    expect(send).toHaveBeenCalledWith({ agentId: AGENT, body: "hello agent" });
    expect(screen.getByText("hello agent")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("should show the refusal when the server refuses the message", async () => {
    const send = vi.fn(async () => ({ ok: false as const, error: "you have read access to this agent, not write access" }));
    render(<DirectThread agentId={AGENT} access="write" initial={[]} send={send} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Message this agent" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("not write access");
  });

  it("should say the message could not be sent when the call itself fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<DirectThread agentId={AGENT} access="write" initial={[]} send={send} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Message this agent" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("could not be sent");
  });

  it("should offer to sign in again instead of a failure when the call fails because the session has ended", async () => {
    const fetch = sessionAnswers(401);
    const send = vi.fn(async () => {
      throw new Error("An unexpected response was received from the server.");
    });
    render(<DirectThread agentId={AGENT} access="write" initial={[]} send={send} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Message this agent" }));
    });

    expect(fetch).toHaveBeenCalledWith("/api/ui/session", expect.anything());
    expect(screen.getByRole("status").textContent).toContain("Your session has ended");
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/auth/login?redirect=%2F");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should not send when the message is only whitespace", async () => {
    const send = vi.fn();
    render(<DirectThread agentId={AGENT} access="owner" initial={[]} send={send} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Message this agent" }));
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("should watch the agent and show a live message and its delivery when they arrive", async () => {
    vi.stubGlobal("EventSource", FakeSource);
    render(
      <HubStreamProvider>
        <DirectThread agentId={AGENT} access="read" initial={[message("1")]} send={vi.fn()} />
      </HubStreamProvider>
    );

    expect(FakeSource.last?.url).toBe(`/api/ui/stream?agent=${AGENT}`);
    await act(async () => {
      FakeSource.last?.emit("direct", { message: message("2", { body: "live one" }) });
    });
    expect(screen.getByText("live one")).toBeTruthy();
    expect(screen.getAllByText("queued")).toHaveLength(2);

    await act(async () => {
      FakeSource.last?.emit("delivery", { message_id: "1", state: "delivered" });
    });

    expect(screen.getAllByText("queued")).toHaveLength(1);
    expect(screen.getByText("delivered").closest("li")?.getAttribute("data-message-id")).toBe("1");
  });
});

describe("DirectThread message ids", () => {
  it("should link each entry's id to its message page when rendering the thread", () => {
    render(<DirectThread agentId={AGENT} access="read" initial={[message("41")]} send={vi.fn()} />);

    expect(screen.getByRole("link", { name: "#41" }).getAttribute("href")).toBe("/m/41");
  });
});
