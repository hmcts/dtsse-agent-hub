/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClaudeMdActions, ClaudeMdSection } from "@/components/credentials/ClaudeMdSection";
import { DEFAULT_CLAUDE_MD, MAX_CLAUDE_MD_CHARACTERS } from "@/credentials/claude-md";
import type { ClaudeMdSettings } from "@/web/data";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

const STORED: ClaudeMdSettings = { available: true, stored: true, text: "# Me\n\nI work on PCS.", updatedAt: "2026-10-05T09:00:00.000Z" };
const NOTHING: ClaudeMdSettings = { available: true, stored: false, text: DEFAULT_CLAUDE_MD, updatedAt: null };

function actions(): ClaudeMdActions {
  return {
    save: vi.fn(async () => ({ ok: true as const, confirmation: "Your CLAUDE.md is saved" })),
    reset: vi.fn(async () => ({ ok: true as const, confirmation: "Your CLAUDE.md is back to the default" }))
  };
}

function show(settings: ClaudeMdSettings, given = actions()) {
  const view = render(<ClaudeMdSection settings={settings} actions={given} />);
  return { given, rerender: (next: ClaudeMdSettings) => view.rerender(<ClaudeMdSection settings={next} actions={given} />) };
}

function editor(): HTMLTextAreaElement {
  return screen.getByLabelText("CLAUDE.md") as HTMLTextAreaElement;
}

describe("ClaudeMdSection", () => {
  it("should head the section, say where the file goes and when changes apply, when it is on the page", () => {
    show(NOTHING);

    const section = screen.getByRole("region", { name: "Your CLAUDE.md" });
    expect(section.id).toBe("claude-md");
    expect(section.textContent).toContain("Written to ~/.claude/CLAUDE.md in each of your virtual agents before Claude starts.");
    expect(section.textContent).toContain("Applies to all of them.");
    expect(section.textContent).toContain("Changes reach a running agent the next time its Claude starts.");
  });

  it("should fill the editor with the default, say so and offer no reset when nothing is stored", () => {
    show(NOTHING);

    expect(editor().value).toBe(DEFAULT_CLAUDE_MD);
    expect(screen.getByText("This is the default. Nothing of yours is stored yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
  });

  it("should fill the editor with the stored text in a monospace field, with when it was saved and a reset, when one is stored", () => {
    show(STORED);

    expect(editor().value).toBe("# Me\n\nI work on PCS.");
    expect(editor().className).toContain("font-mono");
    expect(
      screen
        .getByText(/Last saved/)
        .querySelector("time")
        ?.getAttribute("datetime")
    ).toBe("2026-10-05T09:00:00.000Z");
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeTruthy();
  });

  it("should describe the editor by its hint and counter when it is read by a screen reader", () => {
    show(STORED);

    const described = (editor().getAttribute("aria-describedby") ?? "").split(" ");
    const texts = described.map((id) => document.getElementById(id)?.textContent ?? "");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/^Last saved /);
    expect(texts[1]).toBe("20 of 20,000 characters");
  });

  it("should count characters against the limit as the text is edited, emoji as one", () => {
    show(NOTHING);

    fireEvent.change(editor(), { target: { value: "hi 😀" } });

    expect(screen.getByText("4 of 20,000 characters")).toBeTruthy();
    expect(editor().getAttribute("aria-invalid")).toBe("false");
  });

  it("should mark the editor invalid and say by how much when the text is over the limit", () => {
    show(NOTHING);

    fireEvent.change(editor(), { target: { value: "a".repeat(MAX_CLAUDE_MD_CHARACTERS + 5) } });

    expect(screen.getByText("20,005 of 20,000 characters: 5 too many")).toBeTruthy();
    expect(editor().getAttribute("aria-invalid")).toBe("true");
  });

  it("should send the edited text to the save action, keep it in the editor and confirm when it is saved", async () => {
    const { given } = show(NOTHING);

    fireEvent.change(editor(), { target: { value: "# Mine\n" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Save your CLAUDE.md" }));
    });

    expect(((given.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FormData).get("value")).toBe("# Mine\n");
    expect(editor().value).toBe("# Mine\n");
    expect(screen.getByRole("status").textContent).toBe("Your CLAUDE.md is saved");
    expect(refresh).toHaveBeenCalled();
  });

  it("should show the refusal as an alert and keep the text when the save is refused", async () => {
    const given = actions();
    given.save = vi.fn(async () => ({ ok: false as const, error: "your CLAUDE.md can only hold printable text, tabs and new lines" }));
    show(NOTHING, given);

    fireEvent.change(editor(), { target: { value: "bad" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Save your CLAUDE.md" }));
    });

    expect(screen.getByRole("alert").textContent).toBe("your CLAUDE.md can only hold printable text, tabs and new lines");
    expect(editor().value).toBe("bad");
  });

  it("should call the reset action and put the default back in the editor when it is reset", async () => {
    const { given, rerender } = show(STORED);

    fireEvent.change(editor(), { target: { value: "unsaved edit" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Reset your CLAUDE.md to the default" }));
    });

    expect(given.reset).toHaveBeenCalledTimes(1);
    expect(editor().value).toBe(DEFAULT_CLAUDE_MD);
    expect(screen.getByRole("status").textContent).toBe("Your CLAUDE.md is back to the default");

    rerender(NOTHING);
    expect(editor().value).toBe(DEFAULT_CLAUDE_MD);
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
  });

  it("should take the newly stored text when the page refreshes and the editor has no unsaved edits", () => {
    const { rerender } = show(STORED);

    rerender({ ...STORED, text: "saved in another tab" });

    expect(editor().value).toBe("saved in another tab");
  });

  it("should keep unsaved edits when the page refreshes with other stored text", () => {
    const { rerender } = show(STORED);

    fireEvent.change(editor(), { target: { value: "typing" } });
    rerender({ ...STORED, text: "saved in another tab" });

    expect(editor().value).toBe("typing");
  });

  it("should say it is unavailable, and why, with no editor when the deployment cannot store it", () => {
    show({ available: false, reason: "this deployment has no credentials vault" });

    const section = screen.getByRole("region", { name: "Your CLAUDE.md" });
    expect(within(section).getByText("Your CLAUDE.md is unavailable")).toBeTruthy();
    expect(within(section).getByText("this deployment has no credentials vault")).toBeTruthy();
    expect(within(section).queryByRole("form")).toBeNull();
  });
});
