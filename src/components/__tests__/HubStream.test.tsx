/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveStatus } from "@/components/agents/LiveStatus";
import { NewAgentWatcher } from "@/components/agents/NewAgentWatcher";
import { HubStreamProvider, useEndSession, useWatch } from "@/components/live/HubStream";
import { SessionEndedBanner } from "@/components/live/SessionEnded";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 1;
  closed = false;
  readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

function current(): FakeSource {
  return FakeSource.all.filter((source) => !source.closed).at(-1)!;
}

function EndsSession() {
  const endSession = useEndSession();
  return (
    <button type="button" onClick={endSession}>
      end
    </button>
  );
}

function Watching({ agent }: { agent: string }) {
  useWatch([], "any", agent);
  return null;
}

beforeEach(() => {
  FakeSource.all = [];
  refresh.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeSource);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HubStreamProvider", () => {
  it("should reopen the stream for what the page watches and go back to statuses only when it stops", () => {
    const { rerender } = render(
      <HubStreamProvider>
        <Watching agent="agent-1" />
      </HubStreamProvider>
    );
    expect(current().url).toBe("/api/ui/stream?agent=agent-1");

    rerender(<HubStreamProvider>{null}</HubStreamProvider>);

    expect(current().url).toBe("/api/ui/stream");
  });

  it("should update an agent's dot when its status changes", async () => {
    render(
      <HubStreamProvider>
        <LiveStatus agentId="agent-1" initial="idle" labelled />
      </HubStreamProvider>
    );

    await act(async () => {
      current().emit("agent_status", { agent_id: "agent-2", status: "offline" });
      current().emit("agent_status", { agent_id: "agent-1", status: "busy" });
    });

    expect(screen.getByText("busy")).toBeTruthy();
  });

  it("should re-render the server components when the stream resyncs", async () => {
    render(<HubStreamProvider>{null}</HubStreamProvider>);

    await act(async () => {
      current().emit("resync");
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("should refresh once when an agent it does not list changes status", async () => {
    render(
      <HubStreamProvider>
        <NewAgentWatcher known={["agent-1"]} />
      </HubStreamProvider>
    );

    await act(async () => {
      current().emit("agent_status", { agent_id: "agent-1", status: "busy" });
      current().emit("agent_status", { agent_id: "agent-new", status: "idle" });
      current().emit("agent_status", { agent_id: "agent-new", status: "busy" });
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("should stop the stream and show the signed-out banner when the stream fails because the session has ended", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 }))
    );
    render(
      <HubStreamProvider>
        <SessionEndedBanner />
      </HubStreamProvider>
    );
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      current().readyState = 2;
      current().emit("error");
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByRole("alert").textContent).toContain("Your session has ended");
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/auth/login?redirect=%2F");
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0]!.closed).toBe(true);
  });

  it("should close the stream and show the banner when a component reports that the session has ended", async () => {
    render(
      <HubStreamProvider>
        <SessionEndedBanner />
        <EndsSession />
      </HubStreamProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "end" }));
    });

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(FakeSource.all.every((source) => source.closed)).toBe(true);
  });

  it("should show no banner and ignore a reported ended session outside the provider", () => {
    render(
      <>
        <SessionEndedBanner />
        <EndsSession />
      </>
    );

    fireEvent.click(screen.getByRole("button", { name: "end" }));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should do nothing when a live component is rendered outside the provider", () => {
    render(<LiveStatus agentId="agent-1" initial="offline" labelled />);

    expect(screen.getByText("offline")).toBeTruthy();
  });
});
