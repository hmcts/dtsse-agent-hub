import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKGROUND_IMAGE,
  COLOURS,
  LINE_HEIGHT,
  linesIn,
  linesThatFit,
  lint,
  MASTERS,
  type Outline,
  plan,
  runsOf,
  SLIDE,
  textWidth,
  wrappedLines
} from "../masters.ts";
import { everyLayout } from "./fixtures.ts";

test("should make the title slide from the outline's own title, subtitle and notes", () => {
  const [cover] = plan(everyLayout());
  assert.equal(cover.master, "HMCTS_TITLE");
  assert.deepEqual(cover.background, { image: BACKGROUND_IMAGE });
  assert.deepEqual(
    cover.boxes.map((box) => [box.placeholder, box.kind === "text" ? box.runs.map((run) => run.text) : null]),
    [
      ["title", ["Ways of working"]],
      ["subtitle", ["A developer's guide"]]
    ]
  );
  assert.equal(cover.notes, "Welcome");
});

test("should map each slide to its master, in order, keeping ids and notes", () => {
  const planned = plan(everyLayout());
  assert.deepEqual(
    planned.map((slide) => slide.master),
    ["HMCTS_TITLE", "HMCTS_SECTION", "HMCTS_CONTENT", "HMCTS_TWO_COLUMN", "HMCTS_IMAGE", "HMCTS_IMAGE", "HMCTS_CLOSING"]
  );
  assert.deepEqual(
    planned.map((slide) => slide.id),
    [undefined, "part-1", "what", undefined, undefined, undefined, undefined]
  );
  assert.equal(planned[2].notes, "Say this");
});

test("should list the bar first and then the placeholders in reading order on a content slide", () => {
  const content = plan(everyLayout())[2];
  assert.deepEqual(
    content.boxes.map((box) => [box.kind, box.placeholder, box.decorative]),
    [
      ["rect", null, true],
      ["text", "title", false],
      ["text", "body", false]
    ]
  );
  const bar = content.boxes[0];
  assert.equal(bar.kind === "rect" && bar.style.fill, COLOURS.navy);
  assert.deepEqual([bar.x, bar.y, bar.w], [0, 0, SLIDE.w]);
});

test("should turn bullets into runs one level deep, with the deck's bullet characters", () => {
  assert.deepEqual(runsOf(["a", { text: "b", bullets: ["c"] }]), [
    { text: "a", level: 0, bullet: "●" },
    { text: "b", level: 0, bullet: "●" },
    { text: "c", level: 1, bullet: "○" }
  ]);
});

test("should carry a picture's alt text, and none when it is decorative", () => {
  const planned = plan(everyLayout());
  const picture = (n: number) => planned[n].boxes.find((box) => box.kind === "image");
  assert.deepEqual(picture(4), { ...picture(4), src: "picture.png", alt: "A grey rectangle", decorative: false, placeholder: "image" });
  assert.deepEqual(picture(5), { ...picture(5), alt: "", decorative: true });
});

test("should leave out the box for an optional field the slide does not fill", () => {
  const decorative = plan(everyLayout())[5];
  assert.deepEqual(
    decorative.boxes.map((box) => box.placeholder),
    [null, "title", "image"]
  );
});

test("should keep every placeholder on the slide", () => {
  for (const master of MASTERS) {
    for (const box of [...master.fixed, ...master.placeholders]) {
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= SLIDE.w + 1e-9 && box.y + box.h <= SLIDE.h + 1e-9, `${master.name} ${JSON.stringify(box)}`);
    }
  }
});

test("should find nothing to say about an outline within its limits", () => {
  assert.deepEqual(lint(everyLayout()), []);
});

test("should warn, not fail, when text runs over a placeholder's limits", () => {
  const outline: Outline = {
    title: "one two three four five six seven eight nine",
    slides: [{ layout: "HMCTS_CONTENT", title: "Busy", bullets: ["a b c d e f g h i j k l m", "1", "2", "3", "4", { text: "5", bullets: ["6"] }] }]
  };
  assert.deepEqual(
    lint(outline).map((issue) => [issue.level, issue.where]),
    [
      ["warning", "outline.title"],
      ["warning", "slides[0].bullets item 1"],
      ["warning", "slides[0].bullets"]
    ]
  );
});

test("should leave a picture without alt text to the outline check, and warn about alt text on a decorative one", () => {
  const outline: Outline = {
    title: "T",
    slides: [
      { layout: "HMCTS_IMAGE", title: "P", image: { path: "p.png", alt: " " } },
      { layout: "HMCTS_IMAGE", title: "Q", image: { path: "p.png", alt: "A chart", decorative: true } }
    ]
  };
  assert.deepEqual(
    lint(outline).map((issue) => [issue.level, issue.where]),
    [["warning", "slides[1].image"]]
  );
});

/** The worst case the limits allow: words of seven characters, each as wide as most lowercase letters. */
const widest = (words: number): string => Array.from({ length: words }, () => "nnnnnnn").join(" ");

test("should fit the most bullets of the most words the limits allow inside each list's box", () => {
  const lists = MASTERS.flatMap((master) => master.placeholders.filter((spec) => spec.kind === "bullets"));
  assert.ok(lists.length >= 3);
  for (const spec of lists) {
    const { maxWords, maxLines, maxItems } = spec as Required<typeof spec>;
    for (const level of [0, 1]) {
      assert.ok(linesIn(spec, widest(maxWords), level) <= maxLines, `${spec.name} level ${level}`);
    }
    assert.ok(maxItems * maxLines <= linesThatFit(spec), `${spec.name}: ${maxItems} x ${maxLines} lines in ${linesThatFit(spec)}`);
  }
});

test("should fit the most characters the limits allow on the title and closing slides' one line", () => {
  for (const name of ["HMCTS_TITLE", "HMCTS_CLOSING"]) {
    const title = MASTERS.find((master) => master.name === name)?.placeholders.find((spec) => spec.name === "title");
    assert.ok(title?.maxChars !== undefined && title.maxLines === 1, name);
    assert.equal(linesIn(title, "n".repeat(title.maxChars), null), 1, name);
    assert.equal(linesIn(title, "n".repeat(title.maxChars + 1), null), 2, name);
    assert.ok(linesThatFit(title) >= 1, name);
  }
});

test("should measure text in Arial's widths and wrap it at whole words", () => {
  assert.equal(textWidth("Wi", 10), 11.66);
  assert.equal(wrappedLines("aa bb", textWidth("aa bb", 18), 18), 1);
  assert.equal(wrappedLines("aa bb", textWidth("aa bb", 18) - 0.01, 18), 2);
  assert.equal(wrappedLines("", 100, 18), 1);
  assert.equal(wrappedLines("mmmmmmmmmm", textWidth("mmmm", 18), 18), 3);
  assert.equal(LINE_HEIGHT, 1.2);
});

test("should warn when a bullet within its word limit wraps to more lines than it may", () => {
  const long = "Internationalisation, accessibility, responsibilities, documentation, comprehensively, standardisation";
  const outline: Outline = {
    title: "T",
    slides: [
      { layout: "HMCTS_TWO_COLUMN", title: "A", left: [long], right: ["Short"] },
      { layout: "HMCTS_CONTENT", title: "B", bullets: [long.replaceAll(",", ""), "Short"] }
    ]
  };
  assert.deepEqual(
    lint(outline).map((issue) => `${issue.where} ${issue.message}`),
    ["slides[0].left item 1 runs to about 3 lines; keep a bullet to 2 lines", "slides[1].bullets item 1 runs to about 2 lines; keep a bullet to 1 line"]
  );
});

test("should warn when a list's bullets together run past the bottom of its box", () => {
  const long = "Internationalisation accessibility responsibilities documentation comprehensively standardisation";
  const outline: Outline = { title: "T", slides: [{ layout: "HMCTS_CONTENT", title: "B", bullets: [long, long, long, long] }] };
  const issues = lint(outline).map((issue) => `${issue.where} ${issue.message}`);
  assert.equal(issues.length, 5);
  assert.equal(issues[4], "slides[0].bullets runs to about 8 lines; the placeholder fits 7 lines. Split the slide");
});

test("should warn when the deck's title or the closing line runs past one line, by its width rather than its words", () => {
  const outline: Outline = {
    title: "Releasing software every week",
    slides: [
      { layout: "HMCTS_CLOSING", title: "Ways of working at HMCTS" },
      { layout: "HMCTS_CLOSING", title: "WWWWWWWWWWWWWWW" }
    ]
  };
  assert.deepEqual(
    lint(outline).map((issue) => `${issue.where} ${issue.message}`),
    [
      "outline.title runs to about 2 lines; the placeholder fits 1 line, about 23 characters",
      "slides[1].title runs to about 2 lines; the placeholder fits 1 line, about 23 characters"
    ]
  );
});

test("should warn when two slides share a title", () => {
  const outline: Outline = {
    title: "T",
    slides: [
      { layout: "HMCTS_SECTION", title: "Done" },
      { layout: "HMCTS_SECTION", title: "done " }
    ]
  };
  assert.deepEqual(
    lint(outline).map((issue) => issue.where),
    ["slides[1].title"]
  );
});
