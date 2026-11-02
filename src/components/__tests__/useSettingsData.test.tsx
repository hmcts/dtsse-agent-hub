/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsData } from "@/components/assistant/useSettingsData";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const hubHandlers = new Map<string, (data: unknown) => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: (data: unknown) => void) => hubHandlers.set(type, handler)
}));

beforeEach(() => {
  hubHandlers.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function burst(events: number): void {
  for (let i = 0; i < events; i += 1) {
    hubHandlers.get("virtual_agent")?.({});
  }
}

describe("useSettingsData", () => {
  it("should read once more for a burst of virtual agent events when the section is live", async () => {
    const load = vi.fn().mockResolvedValue("agent");
    renderHook(() => useSettingsData("assistant", load, true));
    await advance(0);
    expect(load).toHaveBeenCalledTimes(1);

    burst(5);
    await advance(249);
    expect(load).toHaveBeenCalledTimes(1);
    await advance(1);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("should read again for a later burst once the first has settled", async () => {
    const load = vi.fn().mockResolvedValue("agent");
    renderHook(() => useSettingsData("assistant", load, true));
    await advance(0);

    burst(3);
    await advance(250);
    burst(3);
    await advance(250);

    expect(load).toHaveBeenCalledTimes(3);
  });

  it("should not read again for a virtual agent event when the section is not live", async () => {
    const load = vi.fn().mockResolvedValue("identity");
    renderHook(() => useSettingsData("git-identity", load));
    await advance(0);

    burst(3);
    await advance(250);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("should not read after the section has closed when a burst was still settling", async () => {
    const load = vi.fn().mockResolvedValue("agent");
    const { unmount } = renderHook(() => useSettingsData("assistant", load, true));
    await advance(0);

    burst(2);
    unmount();
    await advance(250);

    expect(load).toHaveBeenCalledTimes(1);
  });
});
