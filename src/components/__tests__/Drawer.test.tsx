/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_ID, SidebarClose, SidebarDrawer, SidebarDrawerProvider, SidebarToggle } from "@/components/sidebar/Drawer";

const navigation = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

beforeEach(() => {
  navigation.pathname = "/";
});

afterEach(() => {
  cleanup();
});

function Page({ hasSidebar = true }: { hasSidebar?: boolean }) {
  return (
    <SidebarDrawerProvider hasSidebar={hasSidebar}>
      <SidebarDrawer>
        <aside aria-label="Sidebar">
          <SidebarClose />
        </aside>
      </SidebarDrawer>
      <SidebarToggle />
    </SidebarDrawerProvider>
  );
}

function drawer(): HTMLElement {
  const element = document.getElementById(SIDEBAR_ID);
  if (element === null) {
    throw new Error("no drawer");
  }
  return element;
}

describe("SidebarDrawer", () => {
  it("should keep the drawer hidden on narrow screens when it has not been opened", () => {
    render(<Page />);

    expect(screen.getByRole("button", { name: "Open sidebar" }).getAttribute("aria-expanded")).toBe("false");
    expect(drawer().className).toContain("max-md:invisible");
  });

  it("should open the drawer and focus its close button when the menu button is pressed", () => {
    render(<Page />);

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    expect(screen.getByRole("button", { name: "Open sidebar" }).getAttribute("aria-expanded")).toBe("true");
    expect(drawer().className).not.toContain("max-md:invisible");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close sidebar" }));
  });

  it("should close the drawer and return focus to the menu button when the close button is pressed", () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));

    expect(drawer().className).toContain("max-md:invisible");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open sidebar" }));
  });

  it("should close the drawer when Escape is pressed", () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(drawer().className).toContain("max-md:invisible");
  });

  it("should close the drawer when the page changes", () => {
    const { rerender } = render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    navigation.pathname = "/topics";
    act(() => rerender(<Page />));

    expect(drawer().className).toContain("max-md:invisible");
  });

  it("should not offer the menu button when there is no sidebar", () => {
    render(<Page hasSidebar={false} />);

    expect(screen.queryByRole("button", { name: "Open sidebar" })).toBeNull();
  });
});
