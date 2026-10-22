/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Mark } from "@/components/assistant/AssistantShell";
import { ThemeSwitch } from "@/components/assistant/ThemeSwitch";

afterEach(() => {
  cleanup();
  // biome-ignore lint/suspicious/noDocumentCookie: clears what the switch under test wrote, the same way it wrote it
  document.cookie = "asst_theme=; Path=/; Max-Age=0";
});

function root(theme = "system") {
  const element = document.createElement("div");
  element.className = "asst-theme";
  element.dataset.theme = theme;
  document.body.append(element);
  return element;
}

describe("ThemeSwitch", () => {
  it("should mark the person's stored choice as checked when it renders", () => {
    render(<ThemeSwitch initial="dark" />);

    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Match my device" }).getAttribute("aria-checked")).toBe("false");
  });

  it("should switch the page's theme and remember it when the person picks one", () => {
    const page = root();
    render(<ThemeSwitch initial="system" />);

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(page.dataset.theme).toBe("light");
    expect(document.cookie).toContain("asst_theme=light");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    page.remove();
  });

  it("should go back to following the device when the person picks that", () => {
    const page = root("dark");
    render(<ThemeSwitch initial="dark" />);

    fireEvent.click(screen.getByRole("radio", { name: "Match my device" }));

    expect(page.dataset.theme).toBe("system");
    expect(document.cookie).toContain("asst_theme=system");
    page.remove();
  });
});

describe("Mark", () => {
  it.each(["sm", "md", "lg"] as const)("should draw the GOV.UK crown, hidden from screen readers, when it is %s", (size) => {
    const { container } = render(<Mark size={size} />);
    const mark = container.firstElementChild!;

    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 64 60");
    expect(mark.textContent).toBe("");
  });
});
