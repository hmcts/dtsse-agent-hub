/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtefactSnapshot, SaveArtefactResult } from "@/app/_actions/assistant";
import { ArtefactPanel, format, type SaveArtefactAction, starterDocument } from "@/components/assistant/ArtefactPanel";
import type { ActionResult } from "@/web/action";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function snapshot(overrides: Partial<ArtefactSnapshot> = {}): ArtefactSnapshot {
  return { title: "Story", markdown: "# Original", version: 2, updatedBy: "user", ...overrides };
}

function saving(...results: ActionResult<SaveArtefactResult>[]) {
  const queue = [...results];
  return vi.fn<SaveArtefactAction>(async () => queue.shift() ?? { ok: true, saved: true, version: 99 });
}

function panel(artefact: ArtefactSnapshot, save: SaveArtefactAction = saving(), props: Partial<Parameters<typeof ArtefactPanel>[0]> = {}) {
  return <ArtefactPanel conversationId={CONVERSATION} artefact={artefact} productLabel="CCD" save={save} onClose={() => undefined} narrow={false} {...props} />;
}

function box(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Document, in markdown" }) as HTMLTextAreaElement;
}

function edit(text: string): void {
  fireEvent.change(box(), { target: { value: text } });
}

async function pause(ms = 1000): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function saveState(): string {
  return screen
    .getAllByRole("status")
    .map((status) => status.textContent ?? "")
    .join("|");
}

describe("format", () => {
  it("should wrap the selection in ** and keep it selected when making it bold", () => {
    expect(format("hello world", 0, 5, "bold")).toEqual({ text: "**hello** world", start: 2, end: 7 });
  });

  it("should wrap the selection in * when making it italic", () => {
    expect(format("hello world", 6, 11, "italic")).toEqual({ text: "hello *world*", start: 7, end: 12 });
  });

  it("should put the marks at the caret when nothing is selected", () => {
    expect(format("abc", 3, 3, "bold")).toEqual({ text: "abc****", start: 5, end: 5 });
  });

  it("should put a bullet at the start of each selected line when making a list", () => {
    expect(format("a\nb", 0, 3, "bullets")).toEqual({ text: "- a\n- b", start: 0, end: 7 });
  });

  it("should number each selected line from the start of the first when the selection starts mid-line", () => {
    expect(format("x\nyy\nz", 3, 6, "numbers")).toEqual({ text: "x\n1. yy\n2. z", start: 2, end: 12 });
  });

  it("should mark the caret's line when nothing is selected for a list", () => {
    expect(format("one\ntwo", 5, 5, "bullets")).toEqual({ text: "one\n- two", start: 4, end: 7 });
  });
});

describe("starterDocument", () => {
  it("should title the draft with the product when starting a document", () => {
    expect(starterDocument("CCD")).toMatch(/^# CCD: draft\n/);
  });
});

describe("ArtefactPanel saving", () => {
  it("should save the edit against the version it started from after a pause in typing", async () => {
    vi.useFakeTimers();
    const save = saving({ ok: true, saved: true, version: 3 });
    render(panel(snapshot(), save));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("# Mine");
    expect(saveState()).toContain("Not saved yet");
    await pause(999);
    expect(save).not.toHaveBeenCalled();
    await pause(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ conversationId: CONVERSATION, title: "Story", markdown: "# Mine", baseVersion: 2 });
    expect(saveState()).toContain("Saved");
  });

  it("should save once for a burst of typing when each key comes before the pause ends", async () => {
    vi.useFakeTimers();
    const save = saving({ ok: true, saved: true, version: 3 }, { ok: true, saved: true, version: 4 });
    render(panel(snapshot(), save));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("a");
    await pause(500);
    edit("ab");
    await pause(1000);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ markdown: "ab" }));

    edit("abc");
    await pause(1000);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "abc", baseVersion: 3 }));
  });

  it("should save a new title when the person renames the document", async () => {
    vi.useFakeTimers();
    const save = saving();
    render(panel(snapshot(), save));

    fireEvent.change(screen.getByRole("textbox", { name: "Document title" }), { target: { value: "Renamed" } });
    await pause();

    expect(save).toHaveBeenCalledWith({ conversationId: CONVERSATION, title: "Renamed", markdown: "# Original", baseVersion: 2 });
  });

  it("should say it could not save when the save is refused", async () => {
    vi.useFakeTimers();
    render(panel(snapshot(), saving({ ok: false, error: "too long" })));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("x");
    await pause();

    expect(saveState()).toContain("Could not save");
  });
});

describe("ArtefactPanel conflicts", () => {
  const theirs = snapshot({ markdown: "# Theirs", version: 3, updatedBy: "agent" });

  it("should offer the newer version when the save finds the document has changed", async () => {
    vi.useFakeTimers();
    render(panel(snapshot(), saving({ ok: true, saved: false, current: theirs })));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("# Mine");
    await pause();

    expect(screen.getByRole("alert").textContent).toContain("The assistant has changed this document.");
    expect(box().value).toBe("# Mine");
  });

  it("should say the change came from elsewhere when the person changed it in another tab", async () => {
    vi.useFakeTimers();
    render(panel(snapshot(), saving({ ok: true, saved: false, current: { ...theirs, updatedBy: "user" } })));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("# Mine");
    await pause();

    expect(screen.getByRole("alert").textContent).toContain("This document was changed somewhere else.");
  });

  it("should adopt the newer version when the person chooses Use theirs", async () => {
    vi.useFakeTimers();
    const save = saving({ ok: true, saved: false, current: theirs });
    render(panel(snapshot(), save));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("# Mine");
    await pause();
    fireEvent.click(screen.getByRole("button", { name: "Use theirs" }));

    expect(box().value).toBe("# Theirs");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveState()).toContain("Saved");

    edit("# Theirs, edited");
    await pause();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ baseVersion: 3 }));
  });

  it("should save the person's version over the newer one when they choose Keep mine", async () => {
    vi.useFakeTimers();
    const save = saving({ ok: true, saved: false, current: theirs }, { ok: true, saved: true, version: 4 });
    render(panel(snapshot(), save));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("# Mine");
    await pause();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    });

    expect(save).toHaveBeenLastCalledWith({ conversationId: CONVERSATION, title: "Story", markdown: "# Mine", baseVersion: 3 });
    expect(box().value).toBe("# Mine");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveState()).toContain("Saved");
  });

  it("should keep the person's version on screen when they choose Keep mine after the page has the newer version", async () => {
    vi.useFakeTimers();
    let finish: (result: ActionResult<SaveArtefactResult>) => void = () => undefined;
    const save = vi
      .fn<SaveArtefactAction>()
      .mockResolvedValueOnce({ ok: true, saved: false, current: theirs })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
    const { rerender } = render(panel(snapshot(), save));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("# Mine");
    await pause();
    rerender(panel(theirs, save));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    });

    expect(box().value).toBe("# Mine");
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      finish({ ok: true, saved: true, version: 4 });
    });
    expect(box().value).toBe("# Mine");
    expect(saveState()).toContain("Saved");
  });

  it("should take in a newer version at once when the person has no unsaved changes", () => {
    const { rerender } = render(panel(snapshot()));

    rerender(panel(snapshot({ markdown: "# Newer", version: 3, updatedBy: "agent" })));

    expect(screen.getByRole("heading", { name: "Newer" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should raise a conflict for a newer version when the person has unsaved changes", () => {
    vi.useFakeTimers();
    const { rerender } = render(panel(snapshot()));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("# Mine");
    rerender(panel(theirs));

    expect(screen.getByRole("alert").textContent).toContain("The assistant has changed this document.");
    expect(box().value).toBe("# Mine");
  });

  it("should replace the starter outline with the assistant's document when the assistant writes it first", () => {
    const { rerender } = render(panel(snapshot({ title: null, markdown: "", version: 0, updatedBy: null })));

    expect(box().value).toBe(starterDocument("CCD"));
    expect(saveState()).toContain("Not saved yet");
    expect((screen.getByRole("textbox", { name: "Document title" }) as HTMLInputElement).value).toBe("Untitled document");

    rerender(panel(snapshot({ title: "From the assistant", markdown: "# Drafted", version: 1, updatedBy: "agent" })));

    expect(box().value).toBe("# Drafted");
    expect((screen.getByRole("textbox", { name: "Document title" }) as HTMLInputElement).value).toBe("From the assistant");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveState()).toContain("Saved");
  });
});

describe("ArtefactPanel tools", () => {
  it("should copy the markdown and say so when the person clicks Copy", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(panel(snapshot()));

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("# Original");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("should open a written document as a preview and switch to editing when the person chooses Edit", () => {
    render(panel(snapshot()));

    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { level: 3, name: "Original" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bold" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe("true");
    expect(box().value).toBe("# Original");
    expect(screen.getByRole("button", { name: "Bold" })).toBeTruthy();
  });

  it("should say the document is empty when previewing an empty one", () => {
    render(panel(snapshot({ markdown: "  " })));

    expect(screen.getByText("This document is empty.")).toBeTruthy();
  });

  it("should format the selection when the person uses the toolbar", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    render(panel(snapshot({ markdown: "word", version: 1 })));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    box().setSelectionRange(0, 4);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    for (const frame of frames) {
      frame(0);
    }

    expect(box().value).toBe("**word**");
    expect([box().selectionStart, box().selectionEnd]).toEqual([2, 6]);
  });

  it("should widen and narrow the panel with the arrow keys on the separator and remember the width", () => {
    render(panel(snapshot()));

    const separator = screen.getByRole("separator", { name: "Resize document panel" });
    expect(separator.getAttribute("aria-valuenow")).toBe("480");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator.getAttribute("aria-valuenow")).toBe("520");
    expect(window.localStorage.getItem("hmcts-assistant-artefact-width")).toBe("520");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("440");
  });

  it("should restore the remembered width when the panel opens again", () => {
    window.localStorage.setItem("hmcts-assistant-artefact-width", "600");
    render(panel(snapshot()));

    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("600");
  });

  it("should cover the page with no separator when the screen is narrow", () => {
    render(panel(snapshot(), saving(), { narrow: true }));

    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("should close when the person clicks Close document", () => {
    const onClose = vi.fn();
    render(panel(snapshot(), saving(), { onClose }));

    fireEvent.click(screen.getByRole("button", { name: "Close document" }));

    expect(onClose).toHaveBeenCalled();
  });
});
