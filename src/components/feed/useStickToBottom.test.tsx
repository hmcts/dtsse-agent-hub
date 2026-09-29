/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useStickToBottom } from "./useStickToBottom.ts";

function List({ entries }: { entries: string[] }) {
  const scroller = useStickToBottom<HTMLDivElement>(entries);
  return (
    <div ref={scroller.ref} onScroll={scroller.onScroll} data-testid="scroller">
      {entries.join(",")}
    </div>
  );
}

/** jsdom does no layout, so the element's sizes are set by hand; `scrollHeight` grows with each entry. */
function sized(element: HTMLElement, clientHeight: number, rowHeight: number): void {
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => (element.textContent?.split(",").length ?? 0) * rowHeight });
}

function scrollTo(element: HTMLElement, top: number): void {
  element.scrollTop = top;
  fireEvent.scroll(element);
}

afterEach(cleanup);

describe("useStickToBottom", () => {
  it("should scroll to the newest entry when entries arrive and the reader is at the bottom", () => {
    const { rerender } = render(<List entries={["a"]} />);
    const scroller = screen.getByTestId("scroller");
    sized(scroller, 100, 100);

    scrollTo(scroller, 90);
    rerender(<List entries={["a", "b", "c"]} />);

    expect(scroller.scrollTop).toBe(300);
  });

  it("should leave the scroll position alone when entries arrive and the reader has scrolled up", () => {
    const { rerender } = render(<List entries={["a", "b", "c"]} />);
    const scroller = screen.getByTestId("scroller");
    sized(scroller, 100, 100);

    scrollTo(scroller, 50);
    rerender(<List entries={["a", "b", "c", "d"]} />);

    expect(scroller.scrollTop).toBe(50);
  });

  it("should stick again when the reader scrolls back to within reach of the bottom", () => {
    const { rerender } = render(<List entries={["a", "b", "c"]} />);
    const scroller = screen.getByTestId("scroller");
    sized(scroller, 100, 100);

    scrollTo(scroller, 50);
    scrollTo(scroller, 130);
    rerender(<List entries={["a", "b", "c", "d"]} />);

    expect(scroller.scrollTop).toBe(400);
  });
});
