/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtefactSnapshot, SaveArtefactResult } from "@/app/_actions/assistant";
import { ArtefactPanel, fileName, format, type SaveArtefactAction, starterDocument } from "@/components/assistant/ArtefactPanel";
import type { ActionResult } from "@/web/action";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";

/** jsdom lays nothing out, but the panel's bounds are worked out from the window's width. */
function viewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  viewport(1024);
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

/** The copy only says what happened once the write has settled, so the click has to be flushed. */
async function copyIt(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy document" }));
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
  it("should copy the markdown and say so when the person copies the document", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(panel(snapshot()));

    expect(screen.queryByText("Document copied")).toBeNull();
    await copyIt();

    expect(writeText).toHaveBeenCalledWith("# Original");
    expect(screen.getByText("Document copied").getAttribute("role")).toBe("status");
  });

  it("should stop saying it copied when the acknowledgement has had its time", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
    render(panel(snapshot()));

    await copyIt();
    await pause(1400);

    expect(screen.queryByText("Document copied")).toBeNull();
  });

  it("should say it could not copy, and not that it did, when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("Write permission denied."))) } });
    render(panel(snapshot()));

    await copyIt();

    expect(screen.queryByText("Document copied")).toBeNull();
    expect(screen.getByText(/Could not copy/).getAttribute("role")).toBe("status");
  });

  it("should say it could not copy when the browser offers no clipboard", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(panel(snapshot()));

    await copyIt();

    expect(screen.queryByText("Document copied")).toBeNull();
    expect(screen.getByText(/Could not copy/)).toBeTruthy();
  });

  it("should take the failure back when a later copy works", async () => {
    let refuse = true;
    const writeText = vi.fn(async () => {
      if (refuse) {
        throw new Error("Document is not focused.");
      }
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(panel(snapshot()));

    await copyIt();
    expect(screen.getByText(/Could not copy/)).toBeTruthy();

    refuse = false;
    await copyIt();

    expect(screen.queryByText(/Could not copy/)).toBeNull();
    expect(screen.getByText("Document copied")).toBeTruthy();
  });

  it("should keep saying it could not copy when the last copy's acknowledgement was still running out", async () => {
    vi.useFakeTimers();
    let refuse = false;
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: vi.fn(async () => {
          if (refuse) {
            throw new Error("Write permission denied.");
          }
        })
      }
    });
    render(panel(snapshot()));

    await copyIt();
    await pause(1000);
    refuse = true;
    await copyIt();
    // When the first copy's 1400ms would have run out, which must not clear what the second one said.
    await pause(400);

    expect(screen.getByText(/Could not copy/)).toBeTruthy();
  });

  it("should name the icon-only buttons for what they do when the toolbar has no labels", () => {
    render(panel(snapshot()));

    expect(screen.getByRole("button", { name: "Copy document" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Download document" }).textContent).toBe("");
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

  /**
   * The preview holds no control of its own, so the tab stop is the only way a keyboard user reaches the rest of a
   * long document. jsdom lays nothing out, so that it overflows at all is a browser check and the violation it raises
   * an axe one: what is assertable here is the tab stop and the name saying what the focus has landed on.
   */
  it("should make the preview a named tab stop so a keyboard user can scroll a long document", () => {
    render(panel(snapshot({ markdown: "# Original" })));

    const preview = screen.getByRole("region", { name: "Document preview" });
    expect(preview.tabIndex).toBe(0);
    expect(preview.className).toContain("overflow-y-auto");
    expect(preview.textContent).toContain("Original");
  });

  it("should leave the scroller out of the tab order when editing, where the box is the tab stop and scrolls itself", () => {
    render(panel(snapshot()));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.queryByRole("region", { name: "Document preview" })).toBeNull();
    expect(box().closest("div")?.className).toContain("overflow-y-auto");
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

  it("should widen the panel as its separator is dragged towards the chat and remember the width", () => {
    render(panel(snapshot()));

    const separator = screen.getByRole("separator", { name: "Resize document panel" });
    fireEvent.pointerDown(separator);
    fireEvent.pointerMove(window, { clientX: window.innerWidth - 600 });
    expect(separator.getAttribute("aria-valuenow")).toBe("600");
    expect(window.localStorage.getItem("hmcts-assistant-artefact-width")).toBeNull();

    fireEvent.pointerUp(window);

    expect(window.localStorage.getItem("hmcts-assistant-artefact-width")).toBe("600");
  });

  it("should stop at its narrowest when its separator is dragged off the right of the page", () => {
    render(panel(snapshot()));

    const separator = screen.getByRole("separator", { name: "Resize document panel" });
    fireEvent.pointerDown(separator);
    fireEvent.pointerMove(window, { clientX: window.innerWidth + 40 });
    fireEvent.pointerUp(window);

    expect(separator.getAttribute("aria-valuenow")).toBe("320");
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

  it("should keep the remembered width through a narrow screen, where the panel covers the page instead", () => {
    window.localStorage.setItem("hmcts-assistant-artefact-width", "400");
    viewport(700);
    const { rerender } = render(panel(snapshot(), saving(), { narrow: true }));

    viewport(1600);
    fireEvent(window, new Event("resize"));
    rerender(panel(snapshot(), saving(), { narrow: false }));

    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("400");
  });

  it("should close when the person clicks Close document", () => {
    const onClose = vi.fn();
    render(panel(snapshot(), saving(), { onClose }));

    fireEvent.click(screen.getByRole("button", { name: "Close document" }));

    expect(onClose).toHaveBeenCalled();
  });
});

describe("fileName", () => {
  it("should name the file after the document when the title is already safe", () => {
    expect(fileName("Hearing outcomes", "md")).toBe("Hearing outcomes.md");
  });

  it("should take out the characters a filename cannot hold when the title has them", () => {
    expect(fileName('Costs: draft <v2> "final"/*?', "md")).toBe("Costs draft v2 final.md");
  });

  it("should fall back to document when the title leaves nothing usable", () => {
    expect(fileName("  ... ", "md")).toBe("document.md");
    expect(fileName("", "md")).toBe("document.md");
  });

  it("should fall back to document when the title is a name Windows reserves", () => {
    expect(fileName("NUL", "md")).toBe("document.md");
    expect(fileName("com1", "md")).toBe("document.md");
  });

  it("should fall back to document when a reserved name has something after it", () => {
    expect(fileName("NUL.txt", "md")).toBe("document.md");
    expect(fileName("COM1.v2", "md")).toBe("document.md");
  });

  it("should keep a title whose first dotted part is not a reserved name", () => {
    expect(fileName("Order v2.1", "md")).toBe("Order v2.1.md");
    expect(fileName("Consultation.NUL", "md")).toBe("Consultation.NUL.md");
  });

  it("should shorten a very long title when it would make an unwieldy filename", () => {
    expect(fileName("w".repeat(200), "md")).toBe(`${"w".repeat(80)}.md`);
  });
});

describe("ArtefactPanel download", () => {
  function downloads(): { files: { type: string; text: Promise<string> }[]; names: string[]; revoked: string[] } {
    const files: { type: string; text: Promise<string> }[] = [];
    const names: string[] = [];
    const revoked: string[] = [];
    // jsdom has neither blob URLs nor downloads: these record what the browser would have been handed.
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        files.push({ type: blob.type, text: blob.text() });
        return `blob:${files.length}`;
      },
      revokeObjectURL: (url: string) => revoked.push(url)
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    return { files, names, revoked };
  }

  function openMenu(): HTMLElement {
    const trigger = screen.getByRole("button", { name: "Download document" });
    fireEvent.click(trigger);
    return trigger;
  }

  function printIt(): void {
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "PDF (opens your print dialogue)" }));
  }

  it("should offer Markdown and PDF when the person opens the download menu", () => {
    render(panel(snapshot()));

    const trigger = openMenu();

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    const menu = screen.getByRole("menu", { name: "Download" });
    expect(menu.getAttribute("id")).toBe(trigger.getAttribute("aria-controls"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Markdown (.md)", "PDF (opens your print dialogue)"]);
  });

  it("should close the menu and put focus back on the trigger when the person presses Escape", () => {
    render(panel(snapshot()));

    const trigger = openMenu();
    screen.getByRole("menuitem", { name: "Markdown (.md)" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("should close the menu when the person clicks outside it", () => {
    render(panel(snapshot()));

    openMenu();
    fireEvent.mouseDown(screen.getByRole("textbox", { name: "Document title" }));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should leave the menu open when the click is inside it", () => {
    render(panel(snapshot()));

    openMenu();
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Markdown (.md)" }));

    expect(screen.getByRole("menu", { name: "Download" })).toBeTruthy();
  });

  it("should close the menu when the person clicks the trigger again", () => {
    render(panel(snapshot()));

    const trigger = openMenu();
    fireEvent.click(trigger);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should download the document's markdown under its title when the person chooses Markdown", async () => {
    const { files, names, revoked } = downloads();
    vi.useFakeTimers();
    render(panel(snapshot()));

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Markdown (.md)" }));

    expect(names).toEqual(["Story.md"]);
    expect(files.map((file) => file.type)).toEqual(["text/markdown;charset=utf-8"]);
    expect(await Promise.all(files.map((file) => file.text))).toEqual(["# Original"]);
    expect(screen.queryByRole("menu")).toBeNull();
    await pause(0);
    expect(revoked).toEqual(["blob:1"]);
  });

  it("should download the edited text rather than the saved version when the person has typed since", async () => {
    const { files } = downloads();
    render(panel(snapshot()));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("# Mine, unsaved");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Markdown (.md)" }));

    expect(await Promise.all(files.map((file) => file.text))).toEqual(["# Mine, unsaved"]);
  });

  it("should name the file after the fallback title when the document has no title", () => {
    const { names } = downloads();
    render(panel(snapshot({ title: null })));

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Markdown (.md)" }));

    expect(names).toEqual(["Untitled document.md"]);
  });

  it("should print the document, and only the document, when the person chooses PDF", () => {
    // What the dialogue is asked to print: the sheet the print rules show, which is the only h1 on the page.
    const printed: string[] = [];
    vi.stubGlobal(
      "print",
      vi.fn(() => {
        const sheet = document.querySelector("h1")?.parentElement;
        printed.push(...Array.from(sheet?.querySelectorAll("h1, h3, p") ?? [], (node) => node.textContent ?? ""));
      })
    );
    render(panel(snapshot({ markdown: "# A heading\n\nA paragraph." })));

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "PDF (opens your print dialogue)" }));

    expect(window.print).toHaveBeenCalledTimes(1);
    expect(printed).toEqual(["Story", "A heading", "A paragraph."]);
    // Once in the panel's own preview, once on the sheet.
    expect(screen.getAllByText("A paragraph.")).toHaveLength(2);
  });

  it("should print the rendered document rather than the markdown when the person is editing it", () => {
    vi.stubGlobal("print", vi.fn());
    render(panel(snapshot()));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    edit("# Mine\n\nTyped, and not saved yet.");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "PDF (opens your print dialogue)" }));

    const sheet = screen.getByRole("heading", { level: 1, name: "Story" }).parentElement;
    expect(Array.from(sheet?.querySelectorAll("h3, p") ?? [], (node) => node.textContent)).toEqual(["Mine", "Typed, and not saved yet."]);
  });

  it("should take the printed sheet back out when the print dialogue has been dealt with", () => {
    vi.stubGlobal("print", vi.fn());
    render(panel(snapshot()));

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "PDF (opens your print dialogue)" }));
    expect(screen.getByRole("heading", { level: 1, name: "Story" })).toBeTruthy();

    fireEvent(window, new Event("afterprint"));

    expect(screen.queryByRole("heading", { level: 1, name: "Story" })).toBeNull();
  });

  it("should let the person print again when the browser never says the dialogue closed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("print", vi.fn());
    render(panel(snapshot()));

    printIt();
    expect(window.print).toHaveBeenCalledTimes(1);
    await pause(59_999);
    expect(screen.getByRole("heading", { level: 1, name: "Story" })).toBeTruthy();
    await pause(1);

    expect(screen.queryByRole("heading", { level: 1, name: "Story" })).toBeNull();
    printIt();
    expect(window.print).toHaveBeenCalledTimes(2);
  });

  it("should say so, and stay usable, when the browser opens no print dialogue", () => {
    vi.stubGlobal(
      "print",
      vi.fn(() => {
        throw new Error("Printing is not available.");
      })
    );
    render(panel(snapshot()));

    printIt();

    expect(screen.getByText(/Could not open the print dialogue/).getAttribute("role")).toBe("status");
    expect(screen.queryByRole("heading", { level: 1, name: "Story" })).toBeNull();
    printIt();
    expect(window.print).toHaveBeenCalledTimes(2);
  });
});
