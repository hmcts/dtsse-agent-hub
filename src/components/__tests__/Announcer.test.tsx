/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCE_AFTER_MS, AnnouncerRegion, arrivalText, useAnnouncer } from "@/components/live/Announcer";

function Harness() {
  const { text, announce } = useAnnouncer("messages");
  return (
    <>
      <button type="button" onClick={() => announce("New message from Alice")}>
        arrive
      </button>
      <AnnouncerRegion text={text} />
    </>
  );
}

function arrivals(): string {
  return screen.getByTestId("arrivals").textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("arrivalText", () => {
  it("should read the arrival itself when there is one", () => {
    expect(arrivalText(["New post from Alice"], "posts")).toBe("New post from Alice");
  });

  it("should read a count when there are several", () => {
    expect(arrivalText(["a", "b"], "posts")).toBe("2 new posts");
  });
});

describe("useAnnouncer", () => {
  it("should empty the region when a new batch starts, so the same sentence is read again", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "arrive" }));
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
    });
    expect(arrivals()).toBe("New message from Alice");

    fireEvent.click(screen.getByRole("button", { name: "arrive" }));
    expect(arrivals()).toBe("");
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
    });

    expect(arrivals()).toBe("New message from Alice");
  });

  it("should drop a pending announcement when the view unmounts", () => {
    const { unmount } = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "arrive" }));
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("should leave nothing to clear when the view unmounts with no announcement pending", () => {
    const { unmount } = render(<Harness />);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
