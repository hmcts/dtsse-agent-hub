/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@/agents/views";
import { HubStreamProvider } from "@/components/live/HubStream";
import { AgentRoster } from "@/components/sidebar/AgentRoster";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }), usePathname: () => "/" }));

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

function agent(id: string, name: string, status: AgentCard["status"]): AgentCard {
  return {
    id,
    name,
    status,
    repo: null,
    branch: null,
    lastHeartbeatAt: "2026-09-29T09:00:00.000Z",
    owner: { oid: "me", name: "Bob Owner", email: null, tid: "dev" }
  };
}

function hrefs(): string[] {
  return within(screen.getByRole("list", { name: "Agents" }))
    .getAllByRole("link")
    .map((link) => link.getAttribute("href") ?? "");
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentRoster", () => {
  it("should re-sort and recount agents when their statuses change on the stream", async () => {
    render(
      <HubStreamProvider>
        <AgentRoster mine={[agent("1", "alpha", "idle"), agent("2", "beta", "offline")]} shared={[agent("3", "gamma", "busy")]} />
      </HubStreamProvider>
    );
    expect(hrefs()).toEqual(["/agents/3", "/agents/1", "/agents/2"]);
    expect(screen.getByText("2 connected")).toBeTruthy();

    await act(async () => {
      FakeSource.last?.emit("agent_status", { agent_id: "2", status: "busy" });
      FakeSource.last?.emit("agent_status", { agent_id: "3", status: "offline" });
    });

    expect(hrefs()).toEqual(["/agents/2", "/agents/1", "/agents/3"]);
    expect(screen.getByText("2 connected")).toBeTruthy();
    expect(within(screen.getByRole("link", { name: /gamma/ })).getByText("offline")).toBeTruthy();
  });
});

describe("AgentRoster last heard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(Date.parse("2026-09-29T11:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should say how long an agent has been silent when it is offline, and nothing when it is live", async () => {
    render(
      <HubStreamProvider>
        <AgentRoster mine={[agent("1", "alpha", "idle"), agent("2", "beta", "offline")]} shared={[]} />
      </HubStreamProvider>
    );

    expect(
      within(screen.getByRole("link", { name: /beta/ }))
        .getByText("2 h ago")
        .getAttribute("datetime")
    ).toBe("2026-09-29T09:00:00.000Z");
    expect(within(screen.getByRole("link", { name: /alpha/ })).queryByText(/ago/)).toBeNull();

    await act(async () => {
      FakeSource.last?.emit("agent_status", { agent_id: "1", status: "offline" });
      FakeSource.last?.emit("agent_status", { agent_id: "unknown", status: "offline" });
    });

    expect(within(screen.getByRole("link", { name: /alpha/ })).getByText("1 min ago")).toBeTruthy();
  });
});
