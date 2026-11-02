/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubStreamProvider, useEndSession, useHubEvent, useWatch } from "@/components/live/HubStream";
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

/** One agent's status as the stream reports it, starting from `initial`. */
function Status({ agentId, initial }: { agentId: string; initial: string }) {
  const [status, setStatus] = useState(initial);
  useHubEvent<{ agent_id: string; status: string }>("agent_status", (event) => {
    if (event.agent_id === agentId) {
      setStatus(event.status);
    }
  });
  return <p>{status}</p>;
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
  // Puts back the real `navigator.onLine` getter for the tests that move the network.
  vi.restoreAllMocks();
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

  it("should hand each event to the components that listen for its type when it arrives", async () => {
    render(
      <HubStreamProvider>
        <Status agentId="agent-1" initial="idle" />
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

  it("should hold the refresh until the network returns when a resync arrives with no network", async () => {
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    render(<HubStreamProvider>{null}</HubStreamProvider>);

    await act(async () => {
      current().emit("resync");
    });
    expect(refresh).not.toHaveBeenCalled();

    onLine.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("should refresh once however many resyncs arrived while the network was down", async () => {
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    render(<HubStreamProvider>{null}</HubStreamProvider>);

    await act(async () => {
      current().emit("resync");
      current().emit("resync");
      current().emit("resync");
    });

    onLine.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      current().emit("resync");
    });

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("should drop a held refresh when the page is left before the network returns", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const { unmount } = render(<HubStreamProvider>{null}</HubStreamProvider>);
    await act(async () => {
      current().emit("resync");
    });

    unmount();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(refresh).not.toHaveBeenCalled();
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
    render(<Status agentId="agent-1" initial="offline" />);

    expect(screen.getByText("offline")).toBeTruthy();
  });
});
