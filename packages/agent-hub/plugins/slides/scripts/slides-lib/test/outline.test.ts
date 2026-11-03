import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkOutline, OutlineError, validateOutline } from "../outline.ts";
import { everyLayout, workDir } from "./fixtures.ts";

const errorsOf = (input: unknown, dir = workDir()) => checkOutline(input, dir).errors;

test("should accept an outline that uses every layout", () => {
  assert.deepEqual(checkOutline(everyLayout(), workDir()), { errors: [], warnings: [] });
});

test("should name the layouts there are when a slide's layout is unknown", () => {
  const [error] = errorsOf({ title: "T", slides: [{ layout: "content", title: "x" }] });
  assert.match(error, /^slides\[0\]\.layout "content" is not a layout: use one of HMCTS_SECTION, HMCTS_CONTENT/);
});

test("should refuse the title layout in slides, since the outline's own title makes it", () => {
  assert.match(errorsOf({ title: "T", slides: [{ layout: "HMCTS_TITLE", title: "x" }] })[0], /made from the outline's own title/);
});

test("should refuse a picture without alt text unless it is decorative", () => {
  const errors = errorsOf({ title: "T", slides: [{ layout: "HMCTS_IMAGE", title: "P", image: { path: "picture.png" } }] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^slides\[0\]\.image\.alt is missing/);
});

test("should refuse a picture that does not exist, saying where it looked", () => {
  const dir = workDir();
  const [error] = errorsOf({ title: "T", slides: [{ layout: "HMCTS_IMAGE", title: "P", image: { path: "nope.png", alt: "a" } }] }, dir);
  assert.equal(error, `slides[0].image.path nope.png does not exist (looked for ${dir}/nope.png)`);
});

test("should refuse a file that is not a PNG, JPEG or GIF", () => {
  const dir = workDir();
  writeFileSync(join(dir, "notes.txt"), "text");
  assert.deepEqual(errorsOf({ title: "T", slides: [{ layout: "HMCTS_IMAGE", title: "P", image: { path: "notes.txt", alt: "a" } }] }, dir), [
    "slides[0].image.path notes.txt is not a PNG, JPEG or GIF"
  ]);
});

test("should refuse bullets nested more than one level deep", () => {
  const errors = errorsOf({ title: "T", slides: [{ layout: "HMCTS_CONTENT", title: "B", bullets: [{ text: "a", bullets: [{ text: "b" }] }] }] });
  assert.deepEqual(errors, ["slides[0].bullets[0].bullets[0] nests too deep: bullets go one level down at most"]);
});

test("should refuse a missing required field and a field the layout does not take", () => {
  assert.deepEqual(errorsOf({ title: "T", slides: [{ layout: "HMCTS_CONTENT", title: "B", caption: "x" }] }), [
    "slides[0].bullets is required by HMCTS_CONTENT",
    "slides[0].caption is not a field of HMCTS_CONTENT, which takes title, bullets"
  ]);
});

test("should refuse a slide id that another slide already has", () => {
  const errors = errorsOf({
    title: "T",
    slides: [
      { id: "a", layout: "HMCTS_SECTION", title: "One" },
      { id: "a", layout: "HMCTS_SECTION", title: "Two" }
    ]
  });
  assert.deepEqual(errors, ['slides[1].id "a" is already slides[0]\'s']);
});

test("should list every problem at once when the outline has several", () => {
  const errors = errorsOf({ slides: [{ layout: "nope" }, { layout: "HMCTS_SECTION" }] });
  assert.equal(errors.length, 3);
});

test("should return the warnings, and build anyway, when text is only over its limits", () => {
  const outline = { title: "T", slides: [{ layout: "HMCTS_SECTION", title: "one two three four five six seven" }] };
  assert.deepEqual(validateOutline(outline, workDir()).warnings, ["slides[0].title has 7 words; the placeholder fits 6"]);
});

test("should throw every problem when the outline cannot be built", () => {
  assert.throws(
    () => validateOutline({ title: "", slides: [] }, workDir()),
    (err: unknown) => err instanceof OutlineError && err.problems.length === 2
  );
});
