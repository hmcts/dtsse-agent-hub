import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_IMAGE, COLOURS, lint, MASTERS, type Outline, plan, runsOf, SLIDE } from "../masters.ts";
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

test("should fail a picture with neither alt text nor decorative", () => {
  const outline: Outline = { title: "T", slides: [{ layout: "HMCTS_IMAGE", title: "P", image: { path: "p.png", alt: " " } }] };
  assert.deepEqual(
    lint(outline).map((issue) => [issue.level, issue.where]),
    [["error", "slides[0].image.alt"]]
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
