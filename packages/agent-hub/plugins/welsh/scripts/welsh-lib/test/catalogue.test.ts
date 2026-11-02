import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point the library at a scratch workspace before it loads.
const ws = mkdtempSync(join(tmpdir(), "welsh-cat-"));
process.env.CFT_WELSH_WORKSPACE = ws;
mkdirSync(join(ws, "apps", "demo", "demo-app", "welsh"), { recursive: true });
// Each service's Welsh is in its home repo: whichever of its repos has welsh/config.yaml.
writeFileSync(join(ws, "workspace.yaml"), "repos:\n  apps/demo/demo-app: { url: hmcts/demo-app }\n  apps/other/other-app: { url: hmcts/other-app }\n");
mkdirSync(join(ws, "apps", "other", "other-app", "welsh"), { recursive: true });
writeFileSync(join(ws, "apps", "demo", "demo-app", "welsh", "config.yaml"), "repos: []\n");
writeFileSync(join(ws, "apps", "other", "other-app", "welsh", "config.yaml"), "repos: []\n");

const { cataloguePath, loadCatalogue, lookup, search } = await import("../catalogue.ts");
const { parseCsv, toCsv } = await import("../csv.ts");
const { matchKey, splitLegacyEnglish } = await import("../normalise.ts");

test("matchKey folds quotes, spacing and wrapping quotes but keeps case", () => {
  assert.equal(matchKey(" “Thank you for reading this document thoroughly.” "), "Thank you for reading this document thoroughly.");
  assert.equal(matchKey("You’re  signed\nin"), "You're signed in");
  assert.notEqual(matchKey("Back"), matchKey("back"));
});

test("splitLegacyEnglish moves a usage note out of the English cell", () => {
  assert.deepEqual(splitLegacyEnglish("“of” (as in, page 3 *of* 6)"), { english: "of", context: "as in, page 3 *of* 6" });
  assert.deepEqual(splitLegacyEnglish("(opens in new tab)"), { english: "(opens in new tab)", context: "" });
});

test("CSV round-trips commas, quotes, newlines and Welsh diacritics", () => {
  const rows = [["a", 'say "hi", then', "line1\nline2", "Ydych chi’n siŵr?"]];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("add supersedes a changed rendering and ignores a repeat", () => {
  const cat = loadCatalogue("demo");
  assert.equal(cat.add({ english: "Continue", welsh: "Parhau", source: "WLU-1" }), "added");
  assert.equal(cat.add({ english: "Continue", welsh: "Parhau", source: "WLU-2" }), "unchanged");
  assert.equal(cat.add({ english: "Continue", welsh: "Ymlaen", source: "WLU-3" }), "superseded-previous");
  assert.deepEqual(
    cat.history("Continue").map((r) => [r.welsh, r.status]),
    [
      ["Parhau", "superseded"],
      ["Ymlaen", "approved"]
    ]
  );
  cat.save();
  assert.equal(loadCatalogue("demo").approved("Continue")[0].welsh, "Ymlaen");
});

test("a WLU return confirms a needs-review row rather than adding a second one", () => {
  writeFileSync(join(ws, "apps", "demo", "demo-app", "welsh", "catalogue.csv"), "");
  const cat = loadCatalogue("demo");
  cat.add({ english: "Back", welsh: "Yn ôl", source: "legacy", status: "needs-review" });
  assert.equal(cat.add({ english: "Back", welsh: "Yn ôl", source: "WLU:batch-1" }), "added");
  assert.deepEqual(
    cat.history("Back").map((r) => [r.welsh, r.status, r.source]),
    [["Yn ôl", "approved", "WLU:batch-1"]]
  );
  assert.equal(lookup("Back", cat).kind, "hit");
  assert.equal(cat.add({ english: "Back", welsh: "Yn ôl", source: "legacy-again", status: "needs-review" }), "unchanged");
  assert.equal(cat.approved("Back")[0].source, "WLU:batch-1");
});

test("going back to an earlier rendering restores its row, so row ids stay unique", () => {
  writeFileSync(join(ws, "apps", "demo", "demo-app", "welsh", "catalogue.csv"), "");
  const cat = loadCatalogue("demo");
  cat.add({ english: "Continue", welsh: "Parhau", source: "WLU-1" });
  cat.add({ english: "Continue", welsh: "Ymlaen", source: "WLU-2" });
  assert.equal(cat.add({ english: "Continue", welsh: "Parhau", source: "WLU-3" }), "superseded-previous");
  assert.deepEqual(
    cat.history("Continue").map((r) => [r.welsh, r.status]),
    [
      ["Parhau", "approved"],
      ["Ymlaen", "superseded"]
    ]
  );
  assert.equal(new Set(cat.rows.map((r) => r.id)).size, cat.rows.length);
});

test("a catalogue belongs to one service, with nothing shared between services", () => {
  assert.equal(cataloguePath("demo"), join(ws, "apps", "demo", "demo-app", "welsh", "catalogue.csv"));
  const other = loadCatalogue("other");
  other.add({ english: "Back", welsh: "Yn ôl", source: "WLU-other" });
  assert.equal(lookup("Back", loadCatalogue("demo")).kind, "miss");
});

test("lookup: ambiguity and variants go to a human, needs-review never fills", () => {
  writeFileSync(join(ws, "apps", "demo", "demo-app", "welsh", "catalogue.csv"), "");
  const svc = loadCatalogue("demo");
  svc.add({ english: "Back", welsh: "Yn ôl", source: "WLU" });
  svc.add({ english: "Before Hon", welsh: "Gerbron Ei Anrhydedd [male] / Gerbron Ei Hanrhydedd [female]", source: "WLU" });
  svc.add({ english: "Search", welsh: "Chwilio", context: "button", source: "WLU" });
  svc.add({ english: "Search", welsh: "Chwiliad", context: "heading", source: "WLU" });
  svc.add({ english: "Draft", welsh: "Drafft", source: "legacy", status: "needs-review" });

  const back = lookup("“Back”", svc);
  assert.equal(back.kind, "hit");
  assert.equal(back.kind === "hit" && back.catalogue, "demo");
  assert.equal(lookup("Before Hon", svc).kind, "ambiguous");
  const s = lookup("Search", svc);
  assert.equal(s.kind === "ambiguous" && s.options.length, 2);
  assert.equal(lookup("Draft", svc).kind, "miss");
  assert.equal(lookup("back", svc).kind, "miss", "case differs — suggestion only");
});

test("search finds either side and shows needs-review but hides superseded", () => {
  const svc = loadCatalogue("demo");
  svc.add({ english: "Sign out", welsh: "Allgofnodi", source: "WLU" });
  svc.add({ english: "Sign out", welsh: "Allgofnodi o'r cyfrif", source: "WLU-2" });
  svc.add({ english: "Draft", welsh: "Drafft", source: "legacy", status: "needs-review" });
  assert.deepEqual(
    search("allgofnodi", svc, "contains", false).map((h) => h.welsh),
    ["Allgofnodi o'r cyfrif"]
  );
  assert.equal(search("allgofnodi", svc, "contains", true).length, 2);
  assert.equal(search("Draft", svc, "exact", false)[0].status, "needs-review");
});

test("the review list has every needs-review row, grouped by English, with why", async () => {
  const { reviewMarkdown } = await import("../review.ts");
  writeFileSync(join(ws, "apps", "demo", "demo-app", "welsh", "catalogue.csv"), "");
  const cat = loadCatalogue("demo");
  cat.add({ english: "Continue", welsh: "Parhau", source: "legacy", status: "needs-review", notes: "Two renderings" });
  cat.add({ english: "Continue", welsh: "Ymlaen", source: "legacy", status: "needs-review", notes: "Two renderings" });
  cat.add({ english: "Download", welsh: "Download", source: "legacy", status: "needs-review", notes: "Same as the English" });
  cat.add({ english: "Back", welsh: "Yn ôl", source: "WLU" });
  const md = reviewMarkdown(cat);
  assert.match(md, /2 English string\(s\)/);
  assert.match(md, /\| Continue \| {2}\| Parhau _\(\w+\)_<br><br>Ymlaen _\(\w+\)_ \| Two renderings \|/);
  assert.match(md, /\| Download \| {2}\| Download _\(\w+\)_ \| Same as the English \|/);
  assert.doesNotMatch(md, /Yn ôl/);
});
