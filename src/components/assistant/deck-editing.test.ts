import { describe, expect, it } from "vitest";
import { assetRef, type DeckOutline, type DeckSlide } from "@/assistant/deck";
import type { Outline } from "@/assistant/slides/masters";
import {
  blankSlide,
  blockingProblem,
  canIndent,
  canOutdent,
  changeLayout,
  fieldHint,
  flatBullets,
  freshId,
  insertAfter,
  layoutLabel,
  layoutsFor,
  moveSlide,
  nestBullets,
  removeAt,
  setLevel,
  slideWarnings
} from "./deck-editing.ts";

const SHA = "a".repeat(64);
const content: DeckSlide = { id: "c", layout: "HMCTS_CONTENT", title: "Content", bullets: ["One", { text: "Two", bullets: ["Two a"] }, "Three"], notes: "N" };
const picture: DeckSlide = { id: "p", layout: "HMCTS_IMAGE", title: "Picture", image: { asset: assetRef(SHA), alt: "A chart" }, caption: "Under it" };
const closing: DeckSlide = { id: "z", layout: "HMCTS_CLOSING", title: "Questions?", subtitle: "Ask" };
const columns: DeckSlide = { id: "t", layout: "HMCTS_TWO_COLUMN", title: "Cols", left: ["L"], right: ["R"] };
const section: DeckSlide = { id: "s", layout: "HMCTS_SECTION", title: "Part" };

describe("bullets", () => {
  it("should flatten one level of nesting into lines and nest them back the same", () => {
    const items = flatBullets(["One", { text: "Two", bullets: ["Two a"] }]);
    expect(items).toEqual([
      { text: "One", level: 0 },
      { text: "Two", level: 0 },
      { text: "Two a", level: 1 }
    ]);
    expect(nestBullets(items)).toEqual(["One", { text: "Two", bullets: ["Two a"] }]);
    expect(flatBullets([{ text: "Lone" }])).toEqual([{ text: "Lone", level: 0 }]);
  });

  it("should indent only a top-level line with one before it, and outdent only a nested one", () => {
    const items = flatBullets(["One", { text: "Two", bullets: ["Two a"] }]);
    expect([0, 1, 2].map((at) => canIndent(items, at))).toEqual([false, true, false]);
    expect([0, 1, 2].map((at) => canOutdent(items, at))).toEqual([false, false, true]);
    expect(nestBullets(setLevel(items, 1, 1))).toEqual([{ text: "One", bullets: ["Two", "Two a"] }]);
  });

  it("should add a line after one at its level, or another, and at the end past the last", () => {
    const items = flatBullets([{ text: "Two", bullets: ["Two a"] }]);
    expect(insertAfter(items, 1)).toEqual([...items, { text: "", level: 1 }]);
    expect(insertAfter(items, 1, 0).at(-1)).toEqual({ text: "", level: 0 });
    expect(insertAfter(items, 9).at(-1)).toEqual({ text: "", level: 0 });
  });

  it("should bring nested lines out when the bullet they hung from is removed first", () => {
    const items = flatBullets([{ text: "Two", bullets: ["Two a"] }, "Three"]);
    expect(removeAt(items, 0)).toEqual([
      { text: "Two a", level: 0 },
      { text: "Three", level: 0 }
    ]);
    expect(nestBullets([{ text: "Orphan", level: 1 }])).toEqual(["Orphan"]);
  });

  it("should bring the removed bullet's nested lines out to the top level when it is mid-list", () => {
    const items = flatBullets([
      { text: "A", bullets: ["a1"] },
      { text: "B", bullets: ["b1"] }
    ]);
    expect(removeAt(items, 2)).toEqual([
      { text: "A", level: 0 },
      { text: "a1", level: 1 },
      { text: "b1", level: 0 }
    ]);
    expect(nestBullets(removeAt(items, 2))).toEqual([{ text: "A", bullets: ["a1"] }, "b1"]);
  });

  it("should leave the other lines as they are when a nested line is removed", () => {
    const items = flatBullets([{ text: "A", bullets: ["a1", "a2"] }, "B"]);
    expect(nestBullets(removeAt(items, 1))).toEqual([{ text: "A", bullets: ["a2"] }, "B"]);
  });
});

describe("slides", () => {
  it("should give a new slide an id no other has, in the hub's form", () => {
    const values = [0, 0, 0.5];
    const random = () => values.shift() ?? 0.75;
    expect(freshId([{ ...section, id: "s_0000" }], random)).toBe("s_8000");
    const taken = Array.from({ length: 1 }, () => ({ ...section, id: "s_c000" }));
    expect(freshId(taken, () => 0.75)).toMatch(/^s_c000c000$/);
  });

  it("should start each layout from words that save as they are", () => {
    expect(blankSlide("HMCTS_CONTENT", "n")).toEqual({ id: "n", layout: "HMCTS_CONTENT", title: "New slide", bullets: ["New point"] });
    expect(blankSlide("HMCTS_TWO_COLUMN", "n")).toMatchObject({ left: ["New point"], right: ["New point"] });
    expect(blankSlide("HMCTS_CLOSING", "n")).toEqual({ id: "n", layout: "HMCTS_CLOSING", title: "Questions?" });
    expect(blankSlide("HMCTS_SECTION", "n")).toEqual({ id: "n", layout: "HMCTS_SECTION", title: "New slide" });
  });

  it("should move a slide, and leave the order alone for a move off either end", () => {
    const slides = [section, content, closing];
    expect(moveSlide(slides, 2, 0).map((one) => one.id)).toEqual(["z", "s", "c"]);
    expect(moveSlide(slides, 0, 3).map((one) => one.id)).toEqual(["s", "c", "z"]);
    expect(moveSlide(slides, 1, 1).map((one) => one.id)).toEqual(["s", "c", "z"]);
  });

  it("should offer a picture layout only to a slide that already has a picture", () => {
    expect(layoutsFor(content).map((one) => one.layout)).not.toContain("HMCTS_IMAGE");
    expect(layoutsFor(picture).map((one) => one.layout)).toContain("HMCTS_IMAGE");
    expect(layoutLabel("HMCTS_TWO_COLUMN")).toBe("Two columns");
    expect(layoutLabel("SOMETHING_ELSE")).toBe("SOMETHING_ELSE");
  });
});

describe("changeLayout", () => {
  it("should carry bullets between one column and two, losing nothing", () => {
    const two = changeLayout(content, "HMCTS_TWO_COLUMN");
    expect(two).toEqual({
      slide: { id: "c", notes: "N", title: "Content", layout: "HMCTS_TWO_COLUMN", left: ["One", { text: "Two", bullets: ["Two a"] }], right: ["Three"] },
      lost: []
    });
    expect(changeLayout(two.slide, "HMCTS_CONTENT").slide).toMatchObject({ bullets: ["One", { text: "Two", bullets: ["Two a"] }, "Three"] });
    expect(changeLayout(columns, "HMCTS_TWO_COLUMN")).toEqual({ slide: columns, lost: [] });
  });

  it("should say a section loses the bullets, a caption or a subtitle", () => {
    expect(changeLayout(content, "HMCTS_SECTION")).toEqual({
      slide: { id: "c", notes: "N", title: "Content", layout: "HMCTS_SECTION" },
      lost: ["the bullets"]
    });
    expect(changeLayout(picture, "HMCTS_SECTION").lost).toEqual(["the picture", "the caption"]);
    expect(changeLayout(closing, "HMCTS_SECTION").lost).toEqual(["the subtitle"]);
    expect(changeLayout(section, "HMCTS_SECTION").lost).toEqual([]);
  });

  it("should make the first bullet a closing slide's subtitle, saying the rest are lost", () => {
    expect(changeLayout(content, "HMCTS_CLOSING")).toEqual({
      slide: { id: "c", notes: "N", title: "Content", layout: "HMCTS_CLOSING", subtitle: "One" },
      lost: ["every bullet but the first, which becomes the subtitle"]
    });
    expect(changeLayout({ ...content, bullets: [{ text: "Only", bullets: ["Under"] }] }, "HMCTS_CLOSING").lost).toHaveLength(1);
    expect(changeLayout({ ...content, bullets: [{ text: "Only" }] }, "HMCTS_CLOSING")).toMatchObject({ slide: { subtitle: "Only" }, lost: [] });
    expect(changeLayout(section, "HMCTS_CLOSING").slide).toEqual({ id: "s", title: "Part", layout: "HMCTS_CLOSING" });
  });

  it("should carry a caption or subtitle over as a bullet, and give an empty slide a bullet to fill", () => {
    expect(changeLayout(picture, "HMCTS_CONTENT")).toEqual({
      slide: { id: "p", title: "Picture", layout: "HMCTS_CONTENT", bullets: ["Under it"] },
      lost: ["the picture"]
    });
    expect(changeLayout(closing, "HMCTS_TWO_COLUMN").slide).toMatchObject({ left: ["Ask"], right: ["New point"] });
    expect(changeLayout(section, "HMCTS_CONTENT").slide).toMatchObject({ bullets: ["New point"] });
    expect(changeLayout({ ...section, id: undefined } as unknown as DeckSlide, "HMCTS_CONTENT").slide).not.toHaveProperty("id");
  });

  it("should leave a slide alone when asked for the picture layout", () => {
    expect(changeLayout(picture, "HMCTS_IMAGE")).toEqual({ slide: picture, lost: [] });
  });
});

describe("blockingProblem", () => {
  const deck = (slides: DeckSlide[], more: Partial<DeckOutline> = {}): DeckOutline => ({ title: "Deck", slides, ...more });

  it("should be nothing for an outline that saves", () => {
    expect(blockingProblem(deck([content]))).toBeNull();
  });

  it("should say which title, field or bullet is empty, on which slide", () => {
    expect(blockingProblem(deck([content], { title: "" }))).toEqual({ slide: 0, message: "The title slide: the title is empty" });
    expect(blockingProblem(deck([section, { ...content, title: " " }]))).toEqual({ slide: 2, message: "Slide 3: the title is empty" });
    expect(blockingProblem(deck([{ ...content, bullets: ["One", ""] }]))).toEqual({ slide: 1, message: "Slide 2: bullet 2 is empty" });
    expect(blockingProblem(deck([{ ...columns, right: [""] }]))).toEqual({ slide: 1, message: "Slide 2: right column bullet 1 is empty" });
    expect(blockingProblem(deck([{ ...closing, subtitle: "" }]))).toEqual({ slide: 1, message: "Slide 2: the subtitle is empty" });
  });

  it("should number an empty top-level bullet as the editor labels it when a bullet before it has nested lines", () => {
    const bullets = [{ text: "One", bullets: ["One a"] }, ""];
    expect(blockingProblem(deck([{ ...content, bullets }]))).toEqual({ slide: 1, message: "Slide 2: bullet 3 is empty" });
    const text = ["One", { text: " ", bullets: ["Two a"] }];
    expect(blockingProblem(deck([{ ...content, bullets: text }]))).toEqual({ slide: 1, message: "Slide 2: bullet 2 is empty" });
  });

  it("should number an empty nested bullet as the editor labels it", () => {
    const left = ["One", { text: "Two", bullets: ["Two a", ""] }];
    expect(blockingProblem(deck([{ ...columns, left }]))).toEqual({ slide: 1, message: "Slide 2: left column bullet 4, nested, is empty" });
    expect(blockingProblem(deck([{ ...content, bullets: [{ text: "One", bullets: [""] }] }]))).toEqual({
      slide: 1,
      message: "Slide 2: bullet 2, nested, is empty"
    });
  });

  it("should pass on anything else the hub's check refuses", () => {
    expect(blockingProblem(deck([{ ...picture, image: { asset: assetRef(SHA), alt: "" } }]))?.message).toBe(
      "Slide 2: give the picture alt text, or mark it decorative"
    );
    expect(blockingProblem(deck([]))?.message).toBe("The deck needs at least one slide after the title slide");
    expect(blockingProblem(deck([{ ...content, notes: "x".repeat(10_001) }]))?.message).toMatch(/^Slide 2: the speaker notes /);
    expect(blockingProblem({ title: "Deck", slides: [content], extra: 1 } as unknown as DeckOutline)?.message).toMatch(/^The title slide: /);
  });
});

describe("slideWarnings", () => {
  const outline: Outline = {
    title: "A title far too long to fit on the one line of the cover",
    slides: [
      { id: "c", layout: "HMCTS_CONTENT", title: "One two three four five six seven eight nine", bullets: ["a b c d e f g h i", "ok"] },
      { id: "d", layout: "HMCTS_SECTION", title: "One two three four five six seven eight nine" }
    ]
  };

  it("should put the plugin's warnings against the slide and field they are about, a bullet's by its line", () => {
    expect(slideWarnings(outline, 0)).toEqual([{ field: "title", message: expect.stringMatching(/the placeholder fits 1 line/) }]);
    expect(slideWarnings(outline, 1)).toEqual([
      { field: "title", message: "has 9 words; the placeholder fits 8" },
      { field: "bullets", item: 0, message: "has 9 words; keep a bullet to 7" }
    ]);
    expect(slideWarnings(outline, 2).map((one) => one.field)).toEqual(["title", "title"]);
  });
});

describe("fieldHint", () => {
  it("should say each placeholder's limits, and nothing for a field with none", () => {
    expect(fieldHint("HMCTS_CONTENT", "bullets")).toBe("Fits up to 6 bullets, nested ones included, 7 words each.");
    expect(fieldHint("HMCTS_TITLE", "title")).toBe("Fits about 23 characters, on one line.");
    expect(fieldHint("HMCTS_SECTION", "title")).toBe("Fits up to 6 words.");
    expect(fieldHint("HMCTS_IMAGE", "image")).toBeUndefined();
    expect(fieldHint("HMCTS_SECTION", "notes")).toBeUndefined();
  });
});
