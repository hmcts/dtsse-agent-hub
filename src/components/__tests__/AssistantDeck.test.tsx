/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetRef, type DeckOutline } from "@/assistant/deck";
import type { DeckSummary, DeckView } from "@/assistant/deck-store";
import { plan } from "@/assistant/slides/masters";
import { DeckPanel, DeckViewer, deckAssetUrl, deckPptxUrl, deckUrl, SharedDeck, type SlideAsk } from "@/components/assistant/DeckPanel";
import { nestRuns, SlideCanvas, slideTitle } from "@/components/assistant/SlideCanvas";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const SHA = "c".repeat(64);
const DECORATIVE = "d".repeat(64);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function outline(overrides: Partial<DeckOutline> = {}): DeckOutline {
  return {
    title: "Ways of working",
    subtitle: "A developer's guide",
    notes: "Welcome everyone",
    slides: [
      { id: "s_0001", layout: "HMCTS_SECTION", title: "Why it matters" },
      {
        id: "s_ab12",
        layout: "HMCTS_CONTENT",
        title: "Releases take three weeks",
        bullets: ["Build", { text: "Test", bullets: ["Unit", "E2E"] }],
        notes: "Say why"
      },
      { id: "s_0003", layout: "HMCTS_TWO_COLUMN", title: "Before and after", left: ["Slow"], right: ["Fast"] },
      {
        id: "s_0004",
        layout: "HMCTS_IMAGE",
        title: "Our pipeline",
        image: { asset: assetRef(SHA), alt: "The pipeline's five stages" },
        caption: "Every stage"
      },
      { id: "s_0005", layout: "HMCTS_IMAGE", title: "The skyline", image: { asset: assetRef(DECORATIVE), decorative: true } },
      { id: "s_0006", layout: "HMCTS_CLOSING", title: "Questions?", subtitle: "#team on Slack" }
    ],
    ...overrides
  };
}

function deck(overrides: Partial<DeckView> = {}): DeckView {
  return {
    title: "Ways of working",
    outline: outline(),
    version: 7,
    updatedBy: "agent",
    updatedAt: "2026-11-03T09:00:00.000Z",
    pptx: true,
    sizes: { [SHA]: { width: 1200, height: 600 } },
    ...overrides
  };
}

/** What the page hands the panel: the deck's version and no outline. */
function summary(overrides: Partial<DeckSummary> = {}): DeckSummary {
  return { title: "Ways of working", version: 7, updatedBy: "agent", pptx: true, ...overrides };
}

/** The outline route, answering each read with the next of `answers` and the last one after that. */
function serving(...answers: (DeckView | number)[]) {
  const reads = vi.fn(async (_url: string, _init?: RequestInit) => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    return typeof answer === "number" ? new Response(JSON.stringify({ error: "no" }), { status: answer }) : new Response(JSON.stringify(answer));
  });
  vi.stubGlobal("fetch", reads);
  return reads;
}

/** Lets the outline's read settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const background = (image: string) => `/bg/${image}`;

describe("SlideCanvas", () => {
  const slides = plan({
    title: "Ways of working",
    subtitle: "A guide",
    slides: [
      { layout: "HMCTS_CONTENT", title: "Releases", bullets: ["Build", { text: "Test", bullets: ["Unit", "E2E"] }] },
      { layout: "HMCTS_IMAGE", title: "Pipeline", image: { path: "/pic.png", alt: "Five stages" }, caption: "Every stage" },
      { layout: "HMCTS_IMAGE", title: "Skyline", image: { path: "/sky.png", decorative: true } }
    ]
  });

  it("should label the slide by its place and title, with its title as a heading and its bullets as nested lists", () => {
    render(<SlideCanvas slide={slides[1]!} index={1} total={4} backgroundSrc={background} />);

    const section = screen.getByRole("region", { name: "Slide 2 of 4: Releases" });
    expect(section.getAttribute("aria-roledescription")).toBe("slide");
    expect(within(section).getByRole("heading", { level: 3, name: "Releases" })).toBeTruthy();
    const [outer, inner] = within(section).getAllByRole("list");
    expect(
      within(outer!)
        .getAllByRole("listitem")
        .map((item) => item.firstChild?.nextSibling?.textContent)
    ).toEqual(["Build", "Test", "Unit", "E2E"]);
    expect(inner?.parentElement?.textContent).toContain("Test");
    // Sibling sub-bullets are one list, not each nested in the one before.
    expect(within(inner!).getAllByRole("listitem")).toHaveLength(2);
    expect(within(inner!).queryAllByRole("list")).toHaveLength(0);
  });

  it("should draw the title slide on the master's artwork, which says nothing to a screen reader", () => {
    const { container } = render(<SlideCanvas slide={slides[0]!} index={0} total={4} backgroundSrc={background} headingLevel={2} />);

    const artwork = container.querySelector("img");
    expect(artwork?.getAttribute("src")).toBe("/bg/hmcts-title-background.png");
    expect(artwork?.getAttribute("alt")).toBe("");
    expect(screen.getByRole("heading", { level: 2, name: "Ways of working" })).toBeTruthy();
    expect(screen.getByText("A guide").tagName).toBe("P");
  });

  it("should give a picture its alt text and size, and a decorative one none", () => {
    const { rerender } = render(
      <SlideCanvas slide={slides[2]!} index={2} total={4} backgroundSrc={background} sizes={{ "/pic.png": { width: 640, height: 320 } }} />
    );

    const picture = screen.getByRole("img", { name: "Five stages" });
    expect(picture.getAttribute("width")).toBe("640");
    expect(screen.getByText("Every stage").tagName).toBe("P");

    rerender(<SlideCanvas slide={slides[3]!} index={3} total={4} backgroundSrc={background} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("should size type in cqw of the slide's own width", () => {
    render(<SlideCanvas slide={slides[1]!} index={1} total={4} backgroundSrc={background} />);

    // 24pt on a 720pt-wide slide.
    expect((screen.getByRole("heading") as HTMLElement).style.fontSize).toBe(`${(24 * 100) / 720}cqw`);
  });

  it("should carry no headings, lists or alt text of its own when it is a thumbnail", () => {
    const { container } = render(
      <>
        <SlideCanvas slide={slides[1]!} index={1} total={4} backgroundSrc={background} thumbnail />
        <SlideCanvas slide={slides[2]!} index={2} total={4} backgroundSrc={background} thumbnail />
      </>
    );

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(container.textContent).toContain("Releases");
  });

  it("should nest each level-one run under the bullet before it, and keep a stray one at the top", () => {
    expect(
      nestRuns([
        { text: "orphan", level: 1, bullet: "○" },
        { text: "a", level: 0, bullet: "●" },
        { text: "a1", level: 1, bullet: "○" },
        { text: "a2", level: 1, bullet: "○" }
      ]).map((item) => [item.run.text, item.children.map((child) => child.text)])
    ).toEqual([
      ["orphan", []],
      ["a", ["a1", "a2"]]
    ]);
  });

  it("should answer an empty title for a slide with no title box", () => {
    expect(slideTitle({ master: "X", background: { color: "FFFFFF" }, boxes: [] })).toBe("");
  });
});

describe("DeckViewer", () => {
  function viewer(props: Partial<Parameters<typeof DeckViewer>[0]> = {}) {
    const announce = vi.fn();
    const onAsk = vi.fn<(ask: SlideAsk) => void>();
    render(<DeckViewer conversationId={CONVERSATION} deck={deck()} announce={announce} onAsk={onAsk} {...props} />);
    return { announce, onAsk };
  }

  const current = () => screen.getByRole("region", { name: /^Slide \d+ of 7/ });
  const rail = () => within(screen.getByRole("list", { name: "Slide thumbnails" })).getAllByRole("button");

  it("should show the title slide first, with a rail of every slide, one of them current", () => {
    viewer();

    expect(current().getAttribute("aria-label")).toBe("Slide 1 of 7: Ways of working");
    expect(rail()).toHaveLength(7);
    expect(rail()[0]?.getAttribute("aria-current")).toBe("true");
    expect(rail().map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
    expect(rail()[1]?.textContent).toContain("Slide 2: Why it matters");
    expect(rail()[1]?.hasAttribute("aria-label")).toBe(false);
  });

  it("should move through the rail with Up, Down, Home and End, keeping one tab stop and announcing the slide", () => {
    const { announce } = viewer();

    fireEvent.keyDown(rail()[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rail()[1]);
    expect(rail()[1]?.tabIndex).toBe(0);
    expect(announce).toHaveBeenLastCalledWith("Slide 2 of 7: Why it matters");

    fireEvent.keyDown(rail()[1]!, { key: "End" });
    expect(current().getAttribute("aria-label")).toBe("Slide 7 of 7: Questions?");
    fireEvent.keyDown(rail()[6]!, { key: "ArrowDown" });
    expect(current().getAttribute("aria-label")).toBe("Slide 7 of 7: Questions?");
    fireEvent.keyDown(rail()[6]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rail()[5]);
    fireEvent.keyDown(rail()[5]!, { key: "Home" });
    expect(document.activeElement).toBe(rail()[0]);
    fireEvent.keyDown(rail()[0]!, { key: "Tab" });
    expect(announce).toHaveBeenCalledTimes(4);
  });

  it("should move with Page Up, Page Down and the arrows on the slide itself, and with the buttons", () => {
    viewer();

    fireEvent.keyDown(current(), { key: "PageDown" });
    fireEvent.keyDown(current(), { key: "ArrowRight" });
    expect(current().getAttribute("aria-label")).toBe("Slide 3 of 7: Releases take three weeks");
    fireEvent.keyDown(current(), { key: "PageUp" });
    fireEvent.keyDown(current(), { key: "ArrowLeft" });
    fireEvent.keyDown(current(), { key: "Enter" });
    expect(current().getAttribute("aria-label")).toBe("Slide 1 of 7: Ways of working");
    expect((screen.getByRole("button", { name: "Previous slide" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(current().getAttribute("aria-label")).toBe("Slide 2 of 7: Why it matters");
    fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    fireEvent.click(rail()[6]!);
    expect((screen.getByRole("button", { name: "Next slide" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should show a slide's speaker notes in a disclosure, and none for a slide without them", () => {
    viewer();

    expect(screen.getByText("Welcome everyone").closest("details")).toBeTruthy();
    fireEvent.click(rail()[1]!);
    expect(screen.queryByText("Speaker notes")).toBeNull();
  });

  it("should hand the slide's reference to the composer when the person asks about it", () => {
    const { onAsk } = viewer();

    fireEvent.click(rail()[2]!);
    fireEvent.click(screen.getByRole("button", { name: "Ask about this slide" }));

    expect(onAsk).toHaveBeenCalledWith({
      reference: '[Slide 3 of "Ways of working" v7, id s_ab12: "Releases take three weeks"]',
      label: "Slide 3: Releases take three weeks"
    });
  });

  it("should offer no question where there is no composer to ask it in", () => {
    viewer({ onAsk: undefined });

    expect(screen.queryByRole("button", { name: "Ask about this slide" })).toBeNull();
  });

  it("should link the latest version's .pptx when the hub holds it, and say it is not built when it does not", () => {
    viewer();
    expect(screen.getByRole("link", { name: "Download .pptx" }).getAttribute("href")).toBe(deckPptxUrl(CONVERSATION, 7));
    cleanup();

    viewer({ deck: deck({ pptx: false }) });
    expect(screen.queryByRole("link", { name: "Download .pptx" })).toBeNull();
    expect(screen.getByText("Not built yet")).toBeTruthy();
  });

  it("should draw pictures from the deck's asset route at their stored size", () => {
    viewer();

    fireEvent.click(rail()[4]!);
    const picture = screen.getByRole("img", { name: "The pipeline's five stages" });
    expect(picture.getAttribute("src")).toBe(deckAssetUrl(CONVERSATION, SHA));
    expect(picture.getAttribute("height")).toBe("600");
  });

  it("should show the whole deck as headings and lists in the text view, pictures by their alt text", () => {
    viewer();

    fireEvent.click(screen.getByRole("button", { name: "Text view" }));

    const text = screen.getByRole("region", { name: "Deck as text" });
    expect(
      within(text)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual([
      "Slide 1: Ways of working",
      "Slide 2: Why it matters",
      "Slide 3: Releases take three weeks",
      "Slide 4: Before and after",
      "Slide 5: Our pipeline",
      "Slide 6: The skyline",
      "Slide 7: Questions?"
    ]);
    expect(within(text).getByText("Unit")).toBeTruthy();
    expect(within(text).getByText("The pipeline's five stages")).toBeTruthy();
    expect(within(text).getByText("Say why")).toBeTruthy();
    expect(within(text).getByText("A developer's guide")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Text view" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Ask about this slide" })).toBeNull();
  });

  it("should stay on the last slide when a newer version has fewer slides than the one being looked at", () => {
    const announce = vi.fn();
    const { rerender } = render(<DeckViewer conversationId={CONVERSATION} deck={deck()} announce={announce} />);
    fireEvent.click(rail()[6]!);

    rerender(
      <DeckViewer conversationId={CONVERSATION} deck={deck({ version: 8, outline: outline({ slides: outline().slides.slice(0, 2) }) })} announce={announce} />
    );

    expect(screen.getByRole("region", { name: /^Slide 3 of 3/ })).toBeTruthy();
  });
});

describe("DeckPanel", () => {
  it("should be a named panel with the deck's title and a close button", async () => {
    serving(deck());
    const onClose = vi.fn();
    render(<DeckPanel conversationId={CONVERSATION} deck={summary()} onClose={onClose} narrow={false} announce={() => undefined} />);
    await settle();

    const panel = screen.getByRole("region", { name: "Slides" });
    expect(within(panel).getByRole("heading", { level: 2, name: "Ways of working" })).toBeTruthy();
    expect(within(panel).getByRole("separator", { name: "Resize slides panel" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Close slides" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("should cover the page with no resize handle when the screen is narrow", async () => {
    serving(deck());
    render(<DeckPanel conversationId={CONVERSATION} deck={summary()} onClose={() => undefined} narrow announce={() => undefined} />);
    await settle();

    expect(screen.getByRole("region", { name: "Slides" }).className).toContain("fixed inset-0");
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("should read the outline, never from a cache, as it opens and again when the page says the version has moved on", async () => {
    const reads = serving(deck(), deck({ version: 8, outline: outline({ slides: outline().slides.slice(0, 2) }) }));
    const { rerender } = render(
      <DeckPanel conversationId={CONVERSATION} deck={summary()} onClose={() => undefined} narrow={false} announce={() => undefined} />
    );
    expect(screen.getByRole("status").textContent).toBe("Loading the slides…");
    await settle();

    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]?.[0]).toBe(deckUrl(CONVERSATION));
    expect(reads.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    expect(screen.getByRole("region", { name: "Slide 1 of 7: Ways of working" })).toBeTruthy();

    // The same version again, as every refresh of the page hands down, reads nothing.
    rerender(<DeckPanel conversationId={CONVERSATION} deck={summary()} onClose={() => undefined} narrow={false} announce={() => undefined} />);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    rerender(<DeckPanel conversationId={CONVERSATION} deck={summary({ version: 8 })} onClose={() => undefined} narrow={false} announce={() => undefined} />);
    // The version on screen stays while the next is read.
    expect(screen.getByRole("region", { name: "Slide 1 of 7: Ways of working" })).toBeTruthy();
    await settle();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("region", { name: "Slide 1 of 3: Ways of working" })).toBeTruthy();
    expect(screen.getByText("Version 8")).toBeTruthy();
  });

  it("should offer the .pptx the page says has arrived without reading the outline again", async () => {
    const reads = serving(deck({ pptx: false }));
    const { rerender } = render(
      <DeckPanel conversationId={CONVERSATION} deck={summary({ pptx: false })} onClose={() => undefined} narrow={false} announce={() => undefined} />
    );
    await settle();
    expect(screen.getByText("Not built yet")).toBeTruthy();

    rerender(<DeckPanel conversationId={CONVERSATION} deck={summary({ pptx: true })} onClose={() => undefined} narrow={false} announce={() => undefined} />);
    await settle();

    expect(screen.getByRole("link", { name: "Download .pptx" })).toBeTruthy();
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("should say it could not load the slides, and read them again when the person asks, when the read fails", async () => {
    const reads = serving(500, deck());
    render(<DeckPanel conversationId={CONVERSATION} deck={summary()} onClose={() => undefined} narrow={false} announce={() => undefined} />);
    await settle();

    expect(screen.getByRole("alert").textContent).toContain("Could not load the slides.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();

    expect(reads).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("region", { name: "Slide 1 of 7: Ways of working" })).toBeTruthy();
  });

  it("should keep the slides it has when a later read fails", async () => {
    serving(deck(), 500);
    const { rerender } = render(
      <DeckPanel conversationId={CONVERSATION} deck={summary()} onClose={() => undefined} narrow={false} announce={() => undefined} />
    );
    await settle();

    rerender(<DeckPanel conversationId={CONVERSATION} deck={summary({ version: 8 })} onClose={() => undefined} narrow={false} announce={() => undefined} />);
    await settle();

    expect(screen.getByRole("region", { name: "Slide 1 of 7: Ways of working" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("SharedDeck", () => {
  it("should show the deck read-only and announce the slide through its own region", async () => {
    const reads = serving(deck());
    vi.useFakeTimers();
    render(<SharedDeck conversationId={CONVERSATION} deck={summary()} />);
    await settle();
    expect(reads.mock.calls[0]?.[0]).toBe(deckUrl(CONVERSATION));

    expect(screen.getByRole("heading", { level: 2, name: "Ways of working" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask about this slide" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId("arrivals").textContent).toBe("Slide 2 of 7: Why it matters");
  });
});
