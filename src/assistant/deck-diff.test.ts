import { describe, expect, it } from "vitest";
import { assetRef, type DeckOutline, type DeckSlide } from "./deck.ts";
import { bulletText, diffDecks, diffSummary, diffWords, MAX_DIFF_CELLS, type WordPart } from "./deck-diff.ts";

const PIC_A = "a".repeat(64);
const PIC_B = "b".repeat(64);

const section = (id: string, title: string): DeckSlide => ({ id, layout: "HMCTS_SECTION", title });
const content = (id: string, title: string, bullets: (string | { text: string; bullets?: string[] })[]): DeckSlide => ({
  id,
  layout: "HMCTS_CONTENT",
  title,
  bullets: bullets as [string]
});

function deck(slides: DeckSlide[], overrides: Partial<DeckOutline> = {}): DeckOutline {
  return { title: "Ways of working", slides, ...overrides };
}

/** The parts as one string, with `[+…]` for added words and `[-…]` for removed ones, so a test reads as the diff does. */
function shown(parts: WordPart[]): string {
  return parts.map((part) => (part.kind === "same" ? part.text : part.kind === "added" ? `[+${part.text}]` : `[-${part.text}]`)).join("");
}

describe("diffWords", () => {
  it("should mark nothing when the text is the same", () => {
    expect(diffWords("Releases take three weeks", "Releases take three weeks")).toEqual([{ kind: "same", text: "Releases take three weeks" }]);
  });

  it("should mark a word replaced as removed then added, between the words both keep", () => {
    expect(shown(diffWords("Releases take three weeks", "Releases take two weeks"))).toBe("Releases take[- three][+ two] weeks");
  });

  it("should mark words added at the end and at the start", () => {
    expect(shown(diffWords("Build and test", "Build and test daily"))).toBe("Build and test[+ daily]");
    expect(shown(diffWords("Build and test", "We build and test"))).toBe("[-Build][+ We build] and test");
  });

  it("should treat every word as added when the older text was empty, and as removed when the newer is", () => {
    expect(diffWords("", "A new caption")).toEqual([{ kind: "added", text: "A new caption" }]);
    expect(diffWords("Old caption", "")).toEqual([{ kind: "removed", text: "Old caption" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("should ignore how much space is between words", () => {
    expect(diffWords("one  two\tthree", "one two three")).toEqual([{ kind: "same", text: "one two three" }]);
  });

  it("should keep line breaks as their own tokens, with no space beside them, when a bullet is added", () => {
    expect(shown(diffWords("Build\nTest", "Build\nTest\nShip"))).toBe("Build\nTest[+\nShip]");
  });

  it("should find the words both keep when the change is in the middle of a long text", () => {
    const words = Array.from({ length: 300 }, (_, n) => `w${n}`);
    const after = [...words.slice(0, 150), "new", ...words.slice(151)];
    expect(shown(diffWords(words.join(" "), after.join(" ")))).toBe(`${words.slice(0, 150).join(" ")}[- w150][+ new] ${words.slice(151).join(" ")}`);
  });

  it("should show the middle as replaced rather than search it when it is too large to compare", () => {
    const side = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1;
    const before = `same ${Array.from({ length: side }, (_, n) => `a${n}`).join(" ")} end`;
    const after = `same ${Array.from({ length: side }, (_, n) => `b${n}`).join(" ")} end`;
    const parts = diffWords(before, after);
    expect(parts.map((part) => part.kind)).toEqual(["same", "removed", "added", "same"]);
    expect(parts[0]?.text).toBe("same");
    expect(parts[3]?.text).toBe(" end");
  });
});

describe("bulletText", () => {
  it("should put each bullet on its own line and mark each sub-bullet", () => {
    expect(bulletText(["Build", { text: "Test", bullets: ["Unit", "E2E"] }, { text: "Ship" }])).toBe("Build\nTest\n– Unit\n– E2E\nShip");
  });

  it("should be empty for no bullets", () => {
    expect(bulletText(undefined)).toBe("");
  });
});

describe("diffDecks", () => {
  it("should find nothing when the versions are the same", () => {
    const outline = deck([section("why", "Why it matters"), content("what", "What to do", ["Build"])]);
    const diff = diffDecks(outline, outline);
    expect(diff.deck).toEqual([]);
    expect(diff.slides.map((slide) => [slide.id, slide.status])).toEqual([
      ["why", "same"],
      ["what", "same"]
    ]);
    expect(diff.counts).toEqual({ added: 0, removed: 0, moved: 0, changed: 0 });
    expect(diffSummary(diff)).toBe("No differences");
  });

  it("should mark a slide added, with where it is in the newer version", () => {
    const diff = diffDecks(deck([section("a", "A")]), deck([section("a", "A"), section("b", "B")]));
    expect(diff.slides.map((slide) => [slide.id, slide.status])).toEqual([
      ["a", "same"],
      ["b", "added"]
    ]);
    expect(diff.slides[1]?.after?.index).toBe(1);
    expect(diff.slides[1]?.before).toBeUndefined();
    expect(diffSummary(diff)).toBe("1 slide added");
  });

  it("should mark a slide removed, after the slide it followed in the older version", () => {
    const diff = diffDecks(deck([section("a", "A"), section("b", "B"), section("c", "C")]), deck([section("a", "A"), section("c", "C")]));
    expect(diff.slides.map((slide) => [slide.id, slide.status])).toEqual([
      ["a", "same"],
      ["b", "removed"],
      ["c", "same"]
    ]);
    expect(diff.slides[1]?.before?.index).toBe(1);
  });

  it("should put a removed first slide first, and keep removed slides in their order", () => {
    const diff = diffDecks(deck([section("a", "A"), section("b", "B"), section("c", "C")]), deck([section("c", "C")]));
    expect(diff.slides.map((slide) => [slide.id, slide.status])).toEqual([
      ["a", "removed"],
      ["b", "removed"],
      ["c", "same"]
    ]);
  });

  it("should not call a slide moved when it only shifted along because of one added before it", () => {
    const diff = diffDecks(deck([section("a", "A"), section("b", "B")]), deck([section("new", "New"), section("a", "A"), section("b", "B")]));
    expect(diff.slides.map((slide) => [slide.id, slide.status])).toEqual([
      ["new", "added"],
      ["a", "same"],
      ["b", "same"]
    ]);
  });

  it("should mark the slide that changed place as moved and leave the rest in order", () => {
    const diff = diffDecks(
      deck([section("a", "A"), section("b", "B"), section("c", "C"), section("d", "D")]),
      deck([section("a", "A"), section("c", "C"), section("d", "D"), section("b", "B")])
    );
    expect(diff.slides.map((slide) => [slide.id, slide.status])).toEqual([
      ["a", "same"],
      ["c", "same"],
      ["d", "same"],
      ["b", "moved"]
    ]);
    expect(diff.slides[3]?.before?.index).toBe(1);
    expect(diff.slides[3]?.after?.index).toBe(3);
    expect(diffSummary(diff)).toBe("1 slide moved");
  });

  it("should call a slide that moved and changed changed, saying it moved as well", () => {
    const diff = diffDecks(
      deck([section("a", "A"), section("b", "B"), section("c", "C")]),
      deck([section("b", "B"), section("c", "C"), section("a", "A, renamed")])
    );
    expect(diff.slides.map((slide) => [slide.id, slide.status, slide.moved])).toEqual([
      ["b", "same", false],
      ["c", "same", false],
      ["a", "changed", true]
    ]);
    expect(diff.counts).toEqual({ added: 0, removed: 0, moved: 1, changed: 1 });
  });

  it("should line slides up by id, so a renamed slide is changed rather than removed and added", () => {
    const diff = diffDecks(deck([section("why", "Why it matters")]), deck([section("why", "Why this matters")]));
    expect(diff.slides).toHaveLength(1);
    expect(diff.slides[0]?.status).toBe("changed");
    expect(diff.slides[0]?.fields.map((field) => [field.field, field.label, shown(field.parts)])).toEqual([["title", "Title", "Why[- it][+ this] matters"]]);
  });

  it("should compare bullets line by line, and say a bullet was added", () => {
    const diff = diffDecks(deck([content("s", "What", ["Build", "Test"])]), deck([content("s", "What", ["Build", "Test", "Ship it"])]));
    const [field] = diff.slides[0]?.fields ?? [];
    expect(field?.label).toBe("Bullets");
    expect(shown(field?.parts ?? [])).toBe("Build\nTest[+\nShip it]");
  });

  it("should compare each column of a two-column slide on its own", () => {
    const before: DeckSlide = { id: "s", layout: "HMCTS_TWO_COLUMN", title: "Then and now", left: ["Slow builds"], right: ["Fast"] };
    const after: DeckSlide = { id: "s", layout: "HMCTS_TWO_COLUMN", title: "Then and now", left: ["Slow builds"], right: ["Fast", "Green"] };
    const diff = diffDecks(deck([before]), deck([after]));
    expect(diff.slides[0]?.fields.map((field) => [field.label, shown(field.parts)])).toEqual([["Right column", "Fast[+\nGreen]"]]);
  });

  it("should compare a picture's alt text and caption, and note a picture replaced under the same alt text", () => {
    const pic = (asset: string, alt: string, caption?: string): DeckSlide => ({
      id: "p",
      layout: "HMCTS_IMAGE",
      title: "Pipeline",
      image: { asset: assetRef(asset), alt },
      ...(caption === undefined ? {} : { caption })
    });
    const captioned = diffDecks(deck([pic(PIC_A, "Five stages", "Every stage")]), deck([pic(PIC_A, "Six stages", "Every stage, checked")]));
    expect(captioned.slides[0]?.fields.map((field) => [field.label, shown(field.parts), field.note])).toEqual([
      ["Picture", "[-Five][+ Six] stages", undefined],
      ["Caption", "Every[- stage][+ stage, checked]", undefined]
    ]);
    const replaced = diffDecks(deck([pic(PIC_A, "Five stages")]), deck([pic(PIC_B, "Five stages")]));
    expect(replaced.slides[0]?.status).toBe("changed");
    expect(replaced.slides[0]?.fields).toEqual([
      { field: "picture", label: "Picture", parts: [{ kind: "same", text: "Five stages" }], note: "The picture itself was replaced." }
    ]);
    const both = diffDecks(deck([pic(PIC_A, "Five stages")]), deck([pic(PIC_B, "Six stages")]));
    expect(both.slides[0]?.fields[0]?.note).toBe("The picture itself was replaced.");
  });

  it("should say a decorative picture is one, so marking it decorative is a change", () => {
    const before: DeckSlide = { id: "p", layout: "HMCTS_IMAGE", title: "Sky", image: { asset: assetRef(PIC_A), alt: "The skyline" } };
    const after: DeckSlide = { id: "p", layout: "HMCTS_IMAGE", title: "Sky", image: { asset: assetRef(PIC_A), decorative: true } };
    const [field] = diffDecks(deck([before]), deck([after])).slides[0]?.fields ?? [];
    expect(shown(field?.parts ?? [])).toBe("[-The skyline][+ Decorative picture]");
  });

  it("should compare speaker notes, a closing slide's subtitle, and the layout when it changes", () => {
    const before: DeckSlide = { id: "end", layout: "HMCTS_CLOSING", title: "Questions?", subtitle: "#team", notes: "Thank them" };
    const after: DeckSlide = { id: "end", layout: "HMCTS_SECTION", title: "Questions?", notes: "Thank everyone" };
    const fields = diffDecks(deck([before]), deck([after])).slides[0]?.fields ?? [];
    expect(fields.map((field) => [field.label, shown(field.parts)])).toEqual([
      ["Layout", "[-Closing][+ Section]"],
      ["Subtitle", "[-#team]"],
      ["Speaker notes", "Thank[- them][+ everyone]"]
    ]);
  });

  it("should compare the title slide's own title, subtitle and notes", () => {
    const diff = diffDecks(deck([section("a", "A")], { subtitle: "A guide" }), deck([section("a", "A")], { title: "Ways of shipping", notes: "Hello" }));
    expect(diff.deck.map((field) => [field.label, shown(field.parts)])).toEqual([
      ["Title", "Ways of[- working][+ shipping]"],
      ["Subtitle", "[-A guide]"],
      ["Speaker notes", "[+Hello]"]
    ]);
    expect(diffSummary(diff)).toBe("The title slide changed");
  });

  it("should treat a slide stored without an id as removed and added, since nothing lines it up", () => {
    const before: DeckSlide = { layout: "HMCTS_SECTION", title: "A" };
    const diff = diffDecks(deck([before]), deck([{ ...before }]));
    expect(diff.slides.map((slide) => slide.status)).toEqual(["removed", "added"]);
    expect(diff.counts).toEqual({ added: 1, removed: 1, moved: 0, changed: 0 });
  });

  it("should count each kind of change and say them all in one sentence", () => {
    const diff = diffDecks(
      deck([section("a", "A"), section("b", "B"), section("c", "C"), section("gone", "Gone")]),
      deck([section("c", "C"), section("a", "A, again"), section("b", "B"), section("new", "New")], { title: "Renamed" })
    );
    expect(diff.counts).toEqual({ added: 1, removed: 1, moved: 1, changed: 1 });
    expect(diffSummary(diff)).toBe("The title slide changed, 1 slide changed, 1 slide added, 1 slide removed and 1 slide moved");
  });

  it("should say slides in the plural when more than one changed", () => {
    const diff = diffDecks(deck([section("a", "A"), section("b", "B")]), deck([section("a", "A2"), section("b", "B2")]));
    expect(diffSummary(diff)).toBe("2 slides changed");
  });
});
