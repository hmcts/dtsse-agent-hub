/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundPanel } from "@/components/NotFoundPanel";

const navigation = { pathname: "/" };
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

afterEach(() => {
  cleanup();
});

function backHome(): string | null {
  return screen.getByRole("link", { name: "Back to home" }).getAttribute("href");
}

describe("NotFoundPanel", () => {
  it.each(["/hub", "/hub/topics", "/hub/topics/extra/deep", "/hub/agents/0f8a", "/hub/nonsense"])(
    "should offer the hub as the way back from %s, which renders without its sidebar",
    (pathname) => {
      navigation.pathname = pathname;

      render(<NotFoundPanel />);

      expect(backHome()).toBe("/hub");
    }
  );

  it.each(["/", "/nonsense", "/assistant", "/assistant/0f8a", "/hubbub", "/hub-other"])("should offer the front door from %s", (pathname) => {
    navigation.pathname = pathname;

    render(<NotFoundPanel />);

    expect(backHome()).toBe("/");
  });
});
