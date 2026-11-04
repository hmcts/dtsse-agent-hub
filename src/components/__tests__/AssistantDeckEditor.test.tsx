/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeckSnapshot, SaveDeckResult } from "@/app/_actions/decks";
import { assetRef, type DeckOutline } from "@/assistant/deck";
import type { DeckSummary, DeckView } from "@/assistant/deck-store";
import { DeckEditor, SAVE_AFTER_MS, type SaveDeckAction, type UnsavedDeckDraft } from "@/components/assistant/DeckEditor";
import { DeckPanel, SharedDeck } from "@/components/assistant/DeckPanel";
import type { ActionResult } from "@/web/action";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const SHA = "c".repeat(64);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function outline(overrides: Partial<DeckOutline> = {}): DeckOutline {
  return {
    title: "Ways of working",
    subtitle: "A developer's guide",
    slides: [
      { id: "s_0001", layout: "HMCTS_SECTION", title: "Why it matters" },
      { id: "s_ab12", layout: "HMCTS_CONTENT", title: "Releases take three weeks", bullets: ["Build", { text: "Test", bullets: ["Unit"] }], notes: "Say why" },
      { id: "s_0003", layout: "HMCTS_TWO_COLUMN", title: "Before and after", left: ["Slow"], right: ["Fast"] },
      {
        id: "s_0004",
        layout: "HMCTS_IMAGE",
        title: "Our pipeline",
        image: { asset: assetRef(SHA), alt: "The pipeline's five stages" },
        caption: "Every stage"
      },
      { id: "s_0005", layout: "HMCTS_CLOSING", title: "Questions?", subtitle: "#team on Slack" }
    ],
    ...overrides
  };
}

function deck(overrides: Partial<DeckView> = {}): DeckView {
  return {
    title: "Ways of working",
    outline: outline(),
    version: 7,
    revision: 9,
    updatedBy: "agent",
    updatedAt: "2026-11-03T09:00:00.000Z",
    pptx: true,
    sizes: { [SHA]: { width: 1200, height: 600 } },
    ...overrides
  };
}

type Saved = ActionResult<SaveDeckResult>;

function saving(...answers: Saved[]) {
  return vi.fn<SaveDeckAction>(async () => (answers.length > 1 ? answers.shift() : answers[0]) as Saved);
}

const SAVED: Saved = { ok: true, saved: true, version: 8, revision: 10, amended: false };

function editor(props: Partial<React.ComponentProps<typeof DeckEditor>> = {}) {
  const announce = vi.fn<(text: string) => void>();
  const onDone = vi.fn();
  const save = (props.save ?? saving(SAVED)) as ReturnType<typeof saving>;
  const view = render(<DeckEditor conversationId={CONVERSATION} deck={deck()} save={save} announce={announce} onDone={onDone} {...props} />);
  return { ...view, announce, onDone, save };
}

/** The rail button for one slide, by its place. */
function slide(n: number): HTMLElement {
  return within(screen.getByRole("list", { name: "Slides" })).getByRole("button", { name: new RegExp(`^Slide ${n}:`) });
}

async function pause(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS);
  });
}

const savedOutline = (save: ReturnType<typeof saving>, call = 0): DeckOutline => (save.mock.calls[call]?.[0].outline ?? null) as DeckOutline;

describe("DeckEditor", () => {
  it("should label every field of a slide, and draw the slide as it is edited", () => {
    editor();

    expect((screen.getByRole("textbox", { name: "Deck title" }) as HTMLInputElement).value).toBe("Ways of working");
    expect(screen.getByRole("textbox", { name: "Subtitle (optional)" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Speaker notes (optional)" })).toBeTruthy();

    fireEvent.click(slide(3));
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Releases take three weeks");
    const bullets = screen.getByRole("group", { name: "Bullets" });
    expect(within(bullets).getByRole("textbox", { name: "Bullet 1" })).toBeTruthy();
    expect((within(bullets).getByRole("textbox", { name: "Bullet 3, nested" }) as HTMLInputElement).value).toBe("Unit");

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Releases take a week" } });
    expect(screen.getByRole("region", { name: "Slide 3 of 6: Releases take a week" })).toBeTruthy();
  });

  it("should give the two columns, the picture and the closing slide each their own labelled fields", () => {
    editor();

    fireEvent.click(slide(4));
    expect(within(screen.getByRole("group", { name: "Left column" })).getByRole("textbox", { name: "Bullet 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Indent bullet 1 in the right column" })).toBeTruthy();

    fireEvent.click(slide(5));
    expect((screen.getByRole("textbox", { name: "Alt text" }) as HTMLTextAreaElement).value).toBe("The pipeline's five stages");
    expect(screen.getByRole("checkbox", { name: /Decorative/ })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Caption (optional)" }) as HTMLInputElement).value).toBe("Every stage");

    fireEvent.click(slide(6));
    expect((screen.getByRole("textbox", { name: "Subtitle (optional)" }) as HTMLInputElement).value).toBe("#team on Slack");
  });

  it("should save after a pause, naming the version and revision it was made from, and say so", async () => {
    vi.useFakeTimers();
    const { save } = editor();

    fireEvent.change(screen.getByRole("textbox", { name: "Deck title" }), { target: { value: "Ways of shipping" } });
    expect(screen.getByText("Not saved yet")).toBeTruthy();
    await pause();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ conversationId: CONVERSATION, baseVersion: 7, baseRevision: 9 });
    expect(savedOutline(save).title).toBe("Ways of shipping");
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("Saved");

    // The next save builds on what the first answered.
    fireEvent.change(screen.getByRole("textbox", { name: "Deck title" }), { target: { value: "Ways of shipping fast" } });
    await pause();
    expect(save.mock.calls[1]?.[0]).toMatchObject({ baseVersion: 8, baseRevision: 10 });
  });

  it("should say it could not save, and save again on Try again", async () => {
    vi.useFakeTimers();
    const save = saving({ ok: false, error: "down" }, SAVED);
    editor({ save });

    fireEvent.change(screen.getByRole("textbox", { name: "Deck title" }), { target: { value: "Ways of shipping" } });
    await pause();
    expect(screen.getByText("Could not save")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("should not save an outline with an empty title, saying where the gap is, and the plugin's limits as warnings", async () => {
    vi.useFakeTimers();
    const { save } = editor();
    fireEvent.click(slide(2));

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "" } });
    await pause();

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Not saved: Slide 2: the title is empty")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "one two three four five six seven" } });
    expect(screen.getByText("has 7 words; the placeholder fits 6")).toBeTruthy();
    expect(screen.getByText("Fits up to 6 words.")).toBeTruthy();
    await pause();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("should add, indent, outdent and remove bullets with buttons named for each, moving focus and announcing each", async () => {
    vi.useFakeTimers();
    const { save, announce } = editor();
    fireEvent.click(slide(3));
    const bullets = () => screen.getByRole("group", { name: "Bullets" });

    fireEvent.click(within(bullets()).getByRole("button", { name: "Add bullet" }));
    const added = within(bullets()).getByRole("textbox", { name: "Bullet 4" });
    expect(document.activeElement).toBe(added);
    expect(announce).toHaveBeenLastCalledWith("Bullet 4 added");
    fireEvent.change(added, { target: { value: "Release" } });

    fireEvent.click(screen.getByRole("button", { name: "Indent bullet 4" }));
    expect(within(bullets()).getByRole("textbox", { name: "Bullet 4, nested" })).toBe(document.activeElement);
    expect(announce).toHaveBeenLastCalledWith("Bullet 4 indented");
    expect((screen.getByRole("button", { name: "Indent bullet 1" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Outdent bullet 3" }));
    expect(announce).toHaveBeenLastCalledWith("Bullet 3 outdented");

    fireEvent.click(screen.getByRole("button", { name: "Remove bullet 1" }));
    expect(announce).toHaveBeenLastCalledWith("Bullet 1 removed");
    expect(document.activeElement).toBe(within(bullets()).getByRole("textbox", { name: "Bullet 1" }));
    await pause();

    expect(savedOutline(save).slides[1]).toMatchObject({ bullets: ["Test", { text: "Unit", bullets: ["Release"] }] });
  });

  it("should add a bullet after the one Enter is pressed in, at its level", () => {
    editor();
    fireEvent.click(slide(3));

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Bullet 3, nested" }), { key: "Enter" });

    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Bullet 4, nested" }));
  });

  it("should add a slide of the chosen layout after the current one, and focus its title", async () => {
    vi.useFakeTimers();
    const { save, announce } = editor();
    fireEvent.click(slide(2));

    fireEvent.change(screen.getByRole("combobox", { name: "New slide's layout" }), { target: { value: "HMCTS_TWO_COLUMN" } });
    fireEvent.click(screen.getByRole("button", { name: "Add slide after slide 2" }));

    expect(slide(3).getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Title" }));
    expect(screen.getByRole("group", { name: "Left column" })).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith("Two columns slide added as slide 3 of 7");
    await pause();
    const added = savedOutline(save).slides[1];
    expect(added).toMatchObject({ layout: "HMCTS_TWO_COLUMN", title: "New slide", left: ["New point"], right: ["New point"] });
    expect(added?.id).toMatch(/^s_[0-9a-f]{4}$/);
    expect(screen.queryByRole("option", { name: "Picture" })).toBeNull();
  });

  it("should duplicate a slide under a new id, and delete one only once confirmed, focusing what is left", async () => {
    vi.useFakeTimers();
    const { save, announce } = editor();
    fireEvent.click(slide(3));

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(announce).toHaveBeenLastCalledWith("Slide 3 duplicated as slide 4");
    expect(slide(4).getAttribute("aria-current")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete slide" });
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Delete slide" }));
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete slide" }));
    expect(announce).toHaveBeenLastCalledWith("Slide 4 deleted. Showing slide 4 of 6");
    expect(document.activeElement).toBe(slide(4));
    await pause();

    const ids = savedOutline(save).slides.map((one) => one.id);
    expect(ids).toEqual(["s_0001", "s_ab12", "s_0003", "s_0004", "s_0005"]);
  });

  it("should move a slide with Move up and Move down, keeping focus on a button that can still move it", () => {
    const { announce } = editor();
    fireEvent.click(slide(3));
    const up = screen.getByRole("button", { name: "Move up" });
    up.focus();

    fireEvent.click(up);
    expect(slide(2).getAttribute("aria-current")).toBe("true");
    expect(slide(2).textContent).toContain("Releases take three weeks");
    expect(announce).toHaveBeenLastCalledWith("Slide moved to position 2 of 6");
    // At the top of the slides, under the title slide, it can only go down.
    expect((up as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move down" }));

    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    expect(slide(3).textContent).toContain("Releases take three weeks");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move down" }));
  });

  it("should move a slide dragged in the rail", () => {
    const { announce } = editor();
    const items = within(screen.getByRole("list", { name: "Slides" })).getAllByRole("listitem");
    const data = { effectAllowed: "", setData: vi.fn() };

    fireEvent.dragStart(items[5]!, { dataTransfer: data });
    fireEvent.dragOver(items[1]!, { dataTransfer: data });
    fireEvent.drop(items[1]!, { dataTransfer: data });

    expect(slide(2).textContent).toContain("Questions?");
    expect(announce).toHaveBeenLastCalledWith("Slide moved to position 2 of 6");
    expect(items[0]?.getAttribute("draggable")).toBe("false");
  });

  it("should say what a change of layout would lose before it is made, and carry the rest over", async () => {
    vi.useFakeTimers();
    const { save } = editor();
    fireEvent.click(slide(3));
    const layout = screen.getByRole("combobox", { name: "Change layout from Content" });

    fireEvent.change(layout, { target: { value: "HMCTS_TWO_COLUMN" } });
    expect(screen.getByText("Everything on this slide carries over to Two columns.")).toBeTruthy();
    fireEvent.change(layout, { target: { value: "HMCTS_SECTION" } });
    expect(screen.getByText("Changing to Section loses the bullets.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
    await pause();

    expect(savedOutline(save).slides[1]).toEqual({ id: "s_ab12", layout: "HMCTS_SECTION", title: "Releases take three weeks", notes: "Say why" });
  });

  it("should keep a picture's alt text or mark it decorative, and remove the picture by making it a content slide", async () => {
    vi.useFakeTimers();
    const { save } = editor();
    fireEvent.click(slide(5));

    fireEvent.click(screen.getByRole("checkbox", { name: /Decorative/ }));
    expect(screen.queryByRole("textbox", { name: "Alt text" })).toBeNull();
    await pause();
    expect(savedOutline(save).slides[3]).toMatchObject({ image: { asset: assetRef(SHA), decorative: true, alt: "The pipeline's five stages" } });

    fireEvent.click(screen.getByRole("button", { name: "Remove picture" }));
    await pause();
    expect(savedOutline(save, 1).slides[3]).toEqual({ id: "s_0004", layout: "HMCTS_CONTENT", title: "Our pipeline", bullets: ["Every stage"] });
  });

  it("should offer the assistant's version or the person's own when a save finds a newer one, keeping theirs on the newer base", async () => {
    vi.useFakeTimers();
    const theirs: DeckSnapshot = { title: "Theirs", outline: outline({ title: "Theirs" }), version: 8, revision: 10, updatedBy: "agent" };
    const save = saving({ ok: true, saved: false, current: theirs }, { ok: true, saved: true, version: 9, revision: 11, amended: false });
    editor({ save });

    fireEvent.change(screen.getByRole("textbox", { name: "Deck title" }), { target: { value: "Mine" } });
    await pause();
    expect(screen.getByRole("alert").textContent).toContain("The assistant has changed these slides.");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    });
    expect(save.mock.calls[1]?.[0]).toMatchObject({ baseVersion: 8, baseRevision: 10 });
    expect(savedOutline(save, 1).title).toBe("Mine");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should take the newer version in on Use theirs", async () => {
    vi.useFakeTimers();
    const theirs: DeckSnapshot = { title: "Theirs", outline: outline({ title: "Theirs" }), version: 8, revision: 10, updatedBy: "user" };
    const { save } = editor({ save: saving({ ok: true, saved: false, current: theirs }) });

    fireEvent.change(screen.getByRole("textbox", { name: "Deck title" }), { target: { value: "Mine" } });
    await pause();
    expect(screen.getByRole("alert").textContent).toContain("These slides were changed somewhere else.");
    fireEvent.click(screen.getByRole("button", { name: "Use theirs" }));

    expect((screen.getByRole("textbox", { name: "Deck title" }) as HTMLInputElement).value).toBe("Theirs");
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("should take in a newer version as it arrives when nothing is unsaved, and offer it against an unsaved edit", () => {
    const save = saving(SAVED);
    const props = { conversationId: CONVERSATION, save, announce: vi.fn(), onDone: vi.fn() };
    const { rerender } = render(<DeckEditor {...props} deck={deck()} />);

    rerender(<DeckEditor {...props} deck={deck({ revision: 10, outline: outline({ title: "Amended in another tab" }), updatedBy: "user" })} />);
    expect((screen.getByRole("textbox", { name: "Deck title" }) as HTMLInputElement).value).toBe("Amended in another tab");

    fireEvent.change(screen.getByRole("textbox", { name: "Deck title" }), { target: { value: "Mine" } });
    rerender(<DeckEditor {...props} deck={deck({ version: 8, revision: 11, outline: outline({ title: "The assistant's" }), updatedBy: "agent" })} />);
    expect(screen.getByRole("alert").textContent).toContain("The assistant has changed these slides.");
    expect((screen.getByRole("textbox", { name: "Deck title" }) as HTMLInputElement).value).toBe("Mine");
  });

  it("should report itself busy while an edit is unsaved, and not once it has gone", () => {
    const onBusy = vi.fn<(busy: boolean) => void>();
    const { unmount } = editor({ onBusy, save: vi.fn<SaveDeckAction>(() => new Promise(() => undefined)) });

    fireEvent.change(screen.getByRole("textbox", { name: "Deck title" }), { target: { value: "Mine" } });
    expect(onBusy).toHaveBeenLastCalledWith(true);

    unmount();
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });

  it("should save as it closes, and hand the edit back when that save fails or finds a newer version", async () => {
    const theirs: DeckSnapshot = { title: "Theirs", outline: outline({ title: "Theirs" }), version: 8, revision: 10, updatedBy: "agent" };
    for (const [answer, conflict] of [
      [{ ok: false, error: "down" } as Saved, null],
      [{ ok: true, saved: false, current: theirs } as Saved, theirs]
    ] as const) {
      const onUnsaved = vi.fn<(draft: UnsavedDeckDraft) => void>();
      const { unmount, save } = editor({ onUnsaved, save: saving(answer) });
      fireEvent.change(screen.getByRole("textbox", { name: "Deck title" }), { target: { value: "Mine" } });

      await act(async () => {
        unmount();
      });

      expect(save).toHaveBeenCalledTimes(1);
      expect(onUnsaved).toHaveBeenCalledExactlyOnceWith({ outline: { ...outline(), title: "Mine" }, base: { version: 7, revision: 9 }, conflict });
    }
  });

  it("should hand back an edit that cannot be saved as it closes, without trying", async () => {
    const onUnsaved = vi.fn<(draft: UnsavedDeckDraft) => void>();
    const { unmount, save } = editor({ onUnsaved });
    fireEvent.change(screen.getByRole("textbox", { name: "Deck title" }), { target: { value: "" } });

    await act(async () => {
      unmount();
    });

    expect(save).not.toHaveBeenCalled();
    expect(onUnsaved).toHaveBeenCalledWith(expect.objectContaining({ outline: { ...outline(), title: "" }, conflict: null }));
  });

  it("should open with a handed-back edit, saying it is not saved", () => {
    editor({ draft: { outline: outline({ title: "Mine" }), base: { version: 7, revision: 9 }, conflict: null } });

    expect((screen.getByRole("textbox", { name: "Deck title" }) as HTMLInputElement).value).toBe("Mine");
    expect(screen.getByText("Could not save")).toBeTruthy();
  });

  it("should ask, on Done with a gap in the outline, whether to fix it or discard the changes", async () => {
    const onUnsaved = vi.fn();
    const { onDone, save, unmount } = editor({ onUnsaved });
    fireEvent.click(slide(3));
    fireEvent.change(screen.getByRole("textbox", { name: "Bullet 1" }), { target: { value: " " } });

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Slide 3: bullet 1 is empty, so your changes cannot be saved.");

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    await act(async () => {
      unmount();
    });
    expect(save).not.toHaveBeenCalled();
    expect(onUnsaved).not.toHaveBeenCalled();
  });

  it("should leave edit mode on Done when everything has saved", () => {
    const { onDone } = editor();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("should raise no WCAG A or AA violations on a content slide and a picture slide", async () => {
    const { container } = editor();
    for (const n of [3, 5]) {
      fireEvent.click(slide(n));
      const results = await axe.run(container, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        rules: { "color-contrast": { enabled: false } }
      });
      expect(results.violations.map((violation) => violation.id)).toEqual([]);
    }
  }, 20_000);
});

describe("DeckPanel's editing", () => {
  const SUMMARY: DeckSummary = { title: "Ways of working", version: 7, revision: 9, updatedBy: "agent", pptx: true };

  function serve() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(deck())))
    );
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("should offer Edit slides only with a save, and go back to the viewer on Done", async () => {
    serve();
    const announce = vi.fn();
    const { rerender } = render(<DeckPanel conversationId={CONVERSATION} deck={SUMMARY} onClose={vi.fn()} narrow={false} announce={announce} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Edit slides" })).toBeNull();

    rerender(<DeckPanel conversationId={CONVERSATION} deck={SUMMARY} onClose={vi.fn()} narrow={false} announce={announce} save={saving(SAVED)} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit slides" }));
    expect(screen.getByRole("toolbar", { name: "Editing slides" })).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith("Editing the slides");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("list", { name: "Slide thumbnails" })).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith("Finished editing the slides");
  });

  it("should open straight into the editor with a handed-back edit", async () => {
    serve();
    render(
      <DeckPanel
        conversationId={CONVERSATION}
        deck={SUMMARY}
        onClose={vi.fn()}
        narrow
        announce={vi.fn()}
        save={saving(SAVED)}
        draft={{ outline: outline({ title: "Mine" }), base: { version: 7, revision: 9 }, conflict: null }}
      />
    );
    await settle();

    expect((screen.getByRole("textbox", { name: "Deck title" }) as HTMLInputElement).value).toBe("Mine");
  });

  it("should read the outline again when the revision moves on with the version unchanged", async () => {
    const reads = vi.fn(async () => new Response(JSON.stringify(deck())));
    vi.stubGlobal("fetch", reads);
    const { rerender } = render(<DeckPanel conversationId={CONVERSATION} deck={SUMMARY} onClose={vi.fn()} narrow={false} announce={vi.fn()} />);
    await settle();

    rerender(<DeckPanel conversationId={CONVERSATION} deck={{ ...SUMMARY, revision: 10 }} onClose={vi.fn()} narrow={false} announce={vi.fn()} />);
    await settle();

    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("should never offer editing on a shared chat's page", async () => {
    serve();
    render(<SharedDeck conversationId={CONVERSATION} deck={SUMMARY} />);
    await settle();

    expect(screen.queryByRole("button", { name: "Edit slides" })).toBeNull();
  });
});
