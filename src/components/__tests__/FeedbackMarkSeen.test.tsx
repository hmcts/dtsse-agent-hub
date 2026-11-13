/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkSeen } from "@/components/feedback/dev/MarkSeen";

const handlers = new Map<string, (data: unknown) => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: (data: unknown) => void) => handlers.set(type, handler)
}));

afterEach(() => {
  cleanup();
  handlers.clear();
  vi.useRealTimers();
});

describe("MarkSeen", () => {
  it("should mark the project seen once it is on screen", async () => {
    const markSeen = vi.fn(async () => ({ ok: true as const }));

    await act(async () => {
      render(<MarkSeen projectId="p1" markSeen={markSeen} />);
    });

    expect(markSeen).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" });
  });

  it("should mark it seen again when something arrives on it while open, and not for another project", async () => {
    vi.useFakeTimers();
    const markSeen = vi.fn(async () => ({ ok: true as const }));
    render(<MarkSeen projectId="p1" markSeen={markSeen} />);
    markSeen.mockClear();

    handlers.get("feedback")?.({ project_id: "p2" });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(markSeen).not.toHaveBeenCalled();

    handlers.get("feedback")?.({ project_id: "p1" });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(markSeen).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" });
  });

  it("should say nothing when marking it seen fails", async () => {
    const markSeen = vi.fn(async () => Promise.reject(new Error("offline")));

    await act(async () => {
      render(<MarkSeen projectId="p1" markSeen={markSeen} />);
    });

    expect(markSeen).toHaveBeenCalled();
  });
});
