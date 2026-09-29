/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeardAge, LastHeard } from "@/components/agents/LastHeard";
import { HubStreamProvider } from "@/components/live/HubStream";
import { Timestamp } from "@/components/time/Timestamp";
import { TICK_MS } from "@/components/time/useNow";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }), usePathname: () => "/" }));

const NOW = Date.parse("2026-09-29T14:05:00.000Z");
const TEN_MINUTES_AGO = "2026-09-29T13:55:00.000Z";

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("EventSource", FakeSource);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Timestamp", () => {
  it("should render a time element with the full UK date as its tooltip when given an instant", () => {
    render(<Timestamp iso="2026-09-29T14:05:00.000Z" className="x" />);
    const time = screen.getByText("29 Sept, 15:05");

    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe("2026-09-29T14:05:00.000Z");
    expect(time.getAttribute("title")).toBe("Tuesday, 29 September 2026 at 15:05 BST (UK time)");
    expect(time.className).toBe("x");
  });
});

describe("LastHeard", () => {
  it("should hydrate the server's absolute time without a mismatch and then switch to an age when mounted", async () => {
    const element = <LastHeard agentId="a" status="offline" lastHeartbeatAt={TEN_MINUTES_AGO} />;
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.appendChild(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(container.textContent).toBe("29 Sept, 14:55");

    const root = await act(async () => hydrateRoot(container, element));

    expect(errors).not.toHaveBeenCalled();
    expect(container.textContent).toBe("10 min ago");
    expect(container.querySelector("time")?.getAttribute("title")).toBe("Tuesday, 29 September 2026 at 14:55 BST (UK time)");
    act(() => root.unmount());
    container.remove();
  });

  it("should age as the clock ticks when the agent stays offline", async () => {
    render(<LastHeard agentId="a" status="offline" lastHeartbeatAt={TEN_MINUTES_AGO} />);
    expect(screen.getByText("10 min ago")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(4 * TICK_MS);
    });

    expect(screen.getByText("12 min ago")).toBeTruthy();
  });

  it("should not age past the offline window when the agent is live", () => {
    render(<LastHeard agentId="a" status="busy" lastHeartbeatAt={TEN_MINUTES_AGO} />);

    expect(screen.getByText("1 min ago")).toBeTruthy();
  });

  it("should say just now when the stream announces the agent came back", async () => {
    render(
      <HubStreamProvider>
        <LastHeard agentId="a" status="offline" lastHeartbeatAt={TEN_MINUTES_AGO} />
      </HubStreamProvider>
    );

    await act(async () => {
      FakeSource.last?.emit("agent_status", { agent_id: "other", status: "busy" });
    });
    expect(screen.getByText("10 min ago")).toBeTruthy();

    await act(async () => {
      FakeSource.last?.emit("agent_status", { agent_id: "a", status: "busy" });
    });
    expect(screen.getByText("just now")).toBeTruthy();
  });

  it("should share one interval and stop it when every time on screen has unmounted", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const heard = { status: "offline" as const, at: NOW };

    const { unmount } = render(
      <>
        <HeardAge heard={heard} />
        <HeardAge heard={heard} />
        <HeardAge heard={heard} className="y" />
      </>
    );

    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("just now")).toHaveLength(3);
    unmount();
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });
});
