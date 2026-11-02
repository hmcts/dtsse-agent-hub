/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionMark } from "@/components/assistant/SessionMark";

afterEach(cleanup);

function mark(working: boolean): HTMLElement {
  render(<SessionMark words="On your computer, working" colour="text-asst-ok" working={working} icon={<svg />} />);
  return screen.getByTitle("On your computer, working");
}

describe("SessionMark", () => {
  // The badge alone pulses, so the icon stays still and working differs from ready by shape once the pulse stops.
  it("should pulse the badge and not the icon when the session is working", () => {
    const working = mark(true);

    expect(working.classList.contains("text-asst-ok")).toBe(true);
    expect(working.classList.contains("status-pulse")).toBe(false);
    const badge = working.querySelector('[data-badge="working"]');
    expect(badge?.classList.contains("status-pulse")).toBe(true);
    expect(badge?.classList.contains("bg-current")).toBe(true);
  });

  // The edge is the badge's parent so the pulse on the dot never fades the rail colour that parts it from the outline.
  it("should part the badge from the icon with a rail-coloured edge that does not pulse when the session is working", () => {
    const edge = mark(true).querySelector('[data-badge="working"]')?.parentElement;

    expect(edge?.classList.contains("border-asst-rail")).toBe(true);
    expect(edge?.classList.contains("status-pulse")).toBe(false);
    expect(edge?.getAttribute("aria-hidden")).toBe("true");
  });

  it("should draw no badge and no pulse when the session is not working", () => {
    const ready = mark(false);

    expect(ready.querySelector('[data-badge="working"]')).toBeNull();
    expect(ready.querySelector(".status-pulse")).toBeNull();
    expect(ready.classList.contains("status-pulse")).toBe(false);
  });
});
