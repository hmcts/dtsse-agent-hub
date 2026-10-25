/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRefresh } from "@/components/assistant/AssistantRefresh";

/**
 * What the refresh does without a network. Its debounce and the events it listens for are covered beside the rest
 * of the Assistant's shell, in `AssistantShell.test.tsx`, where the browser has a network throughout.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const hubHandlers = new Map<string, (data: unknown) => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: (data: unknown) => void) => hubHandlers.set(type, handler)
}));

beforeEach(() => {
  refresh.mockReset();
  hubHandlers.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Puts back the real `navigator.onLine` getter.
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

async function reconnect(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
}

describe("AssistantRefresh", () => {
  it("should hold the settled refresh until the network returns when the browser has none", async () => {
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    render(<AssistantRefresh />);

    hubHandlers.get("virtual_agent")?.({});
    await settle();
    expect(refresh).not.toHaveBeenCalled();

    onLine.mockReturnValue(true);
    await reconnect();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("should refresh once however many events arrived while the network was down", async () => {
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    render(<AssistantRefresh />);

    hubHandlers.get("virtual_agent")?.({});
    await settle();
    hubHandlers.get("assistant_conversation")?.({});
    await settle();

    onLine.mockReturnValue(true);
    await reconnect();
    expect(refresh).toHaveBeenCalledTimes(1);

    hubHandlers.get("virtual_agent")?.({});
    await settle();

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("should drop a held refresh when the page has gone before the network returns", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const { unmount } = render(<AssistantRefresh />);
    hubHandlers.get("virtual_agent")?.({});
    await settle();

    unmount();
    await reconnect();

    expect(refresh).not.toHaveBeenCalled();
  });
});
