import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ws = mkdtempSync(join(tmpdir(), "welsh-story-"));
process.env.CFT_WELSH_WORKSPACE = ws;
mkdirSync(join(ws, "apps", "demo", "demo-app", "welsh"), { recursive: true });
// Each service's Welsh is in its home repo: whichever of its repos has welsh/config.yaml.
writeFileSync(join(ws, "workspace.yaml"), "repos:\n  apps/demo/demo-app: { url: hmcts/demo-app }\n  apps/other/other-app: { url: hmcts/other-app }\n");
mkdirSync(join(ws, "apps", "other", "other-app", "welsh"), { recursive: true });
writeFileSync(join(ws, "apps", "demo", "demo-app", "welsh", "config.yaml"), "repos: []\n");
writeFileSync(join(ws, "apps", "other", "other-app", "welsh", "config.yaml"), "repos: []\n");

const { loadCatalogue } = await import("../catalogue.ts");
const { buildRows, candidates, existingRows, notInStory, withSection } = await import("../story.ts");
const { verify } = await import("../verify.ts");
type AdfNode = import("../jira.ts").AdfNode;

const p = (...lines: string[]): AdfNode => ({
  type: "paragraph",
  content: lines.flatMap((t, i) => [...(i ? [{ type: "hardBreak" }] : []), { type: "text", text: t }])
});
const table = (rows: string[][]): AdfNode => ({
  type: "table",
  content: rows.map((r, i) => ({ type: "tableRow", content: r.map((c) => ({ type: i ? "tableCell" : "tableHeader", content: [p(c)] })) }))
});

const STORY: AdfNode = {
  type: "doc",
  version: 1,
  content: [
    p("Then the Welsh translation of the following option is shown:"),
    p("Access tribunal documents"),
    p("“Use this service to access documents.”", 'And the existing "Start now" link remains unchanged.'),
    table([
      ["Key", "English"],
      ["title", "Your appeal"]
    ]),
    { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { id: "img-1", type: "file" } }] }
  ]
};

test("candidates come from Gherkin 'is shown:' lines, quotes and English table columns", () => {
  assert.deepEqual(
    candidates(STORY)
      .map((c) => [c.origin, c.english])
      .sort((a, b) => (a < b ? -1 : Number(a > b))),
    [
      ["after-shown", "Access tribunal documents"],
      ["quoted", "Start now"],
      ["quoted", "Use this service to access documents."],
      ["table", "Your appeal"]
    ]
  );
});

test("strings must appear in the story verbatim (after quote/space normalisation)", () => {
  assert.deepEqual(notInStory(["Access tribunal documents", "Use this service to access documents.", "Made up"], STORY), ["Made up"]);
});

test("rows fill from the catalogue, otherwise placeholder; the section replaces itself and keeps other nodes", () => {
  const cat = loadCatalogue("demo");
  cat.add({ english: "Your appeal", welsh: "Eich apêl", source: "WLU-7" });
  const strings = ["Access tribunal documents", "Your appeal"];

  const first = buildRows("demo", strings, cat, [], new Map());
  assert.deepEqual(
    first.rows.map((r) => r.state),
    ["required", "filled"]
  );
  assert.equal(first.rows[1].welsh, "Eich apêl");
  assert.ok(verify(first.rows, cat).ok);

  const once = withSection(STORY, first.rows);
  const twice = withSection(once, buildRows("demo", strings, cat, existingRows(once), new Map()).rows);
  assert.equal(twice.content!.length, STORY.content!.length + 3, "heading, note and table appended once");
  assert.deepEqual(twice.content!.slice(0, STORY.content!.length), STORY.content, "original nodes untouched, images included");
  assert.equal(candidates(twice).length, candidates(STORY).length, "the generated section is not re-read as content");
});

test("a placeholder is refilled once the WLU's answer is in the catalogue", () => {
  const cat = loadCatalogue("demo");
  const before = withSection(STORY, buildRows("demo", ["Access tribunal documents"], cat, [], new Map()).rows);
  cat.add({ english: "Access tribunal documents", welsh: "Cael mynediad at ddogfennau’r tribiwnlys", source: "WLU-8" });
  const after = buildRows("demo", ["Access tribunal documents"], cat, existingRows(before), new Map());
  assert.equal(after.rows[0].state, "filled");
  assert.equal(after.rows[0].welsh, "Cael mynediad at ddogfennau’r tribiwnlys");
});

test("Welsh typed into the story by hand is kept but fails verify, so it cannot be written", () => {
  const cat = loadCatalogue("demo");
  const edited = withSection(STORY, [{ ref: "CY-1", english: "Start now", welsh: "Dechrau nawr", source: "typed", state: "filled" }]);
  const built = buildRows("demo", ["Start now"], cat, existingRows(edited), new Map());
  assert.equal(built.handEdited.length, 1);
  const check = verify(built.rows, cat);
  assert.equal(check.ok, false);
  assert.match(check.failures[0].reason, /no approved catalogue row/);
});
