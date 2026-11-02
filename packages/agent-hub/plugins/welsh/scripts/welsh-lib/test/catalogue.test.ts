import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point the library at a scratch workspace before it loads.
const ws = mkdtempSync(join(tmpdir(), "welsh-cat-"));
process.env.CFT_WELSH_WORKSPACE = ws;
mkdirSync(join(ws, "apps", "demo", "welsh"), { recursive: true });
mkdirSync(join(ws, "welsh", "shared"), { recursive: true });

const { loadCatalogue, loadCatalogues, lookup, search } = await import("../catalogue.ts");
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

test("lookup: service before shared, ambiguity and variants go to a human, needs-review never fills", () => {
  writeFileSync(join(ws, "apps", "demo", "welsh", "catalogue.csv"), "");
  writeFileSync(join(ws, "welsh", "shared", "catalogue.csv"), "");
  const [svc, shared] = loadCatalogues("demo");
  shared.add({ english: "Back", welsh: "Yn ôl", source: "WLU-shared" });
  svc.add({ english: "Before Hon", welsh: "Gerbron Ei Anrhydedd [male] / Gerbron Ei Hanrhydedd [female]", source: "WLU" });
  svc.add({ english: "Search", welsh: "Chwilio", context: "button", source: "WLU" });
  svc.add({ english: "Search", welsh: "Chwiliad", context: "heading", source: "WLU" });
  svc.add({ english: "Draft", welsh: "Drafft", source: "legacy", status: "needs-review" });

  const back = lookup("“Back”", [svc, shared]);
  assert.equal(back.kind, "hit");
  assert.equal(back.kind === "hit" && back.catalogue, "shared");
  assert.equal(lookup("Before Hon", [svc, shared]).kind, "ambiguous");
  const s = lookup("Search", [svc, shared]);
  assert.equal(s.kind === "ambiguous" && s.options.length, 2);
  assert.equal(lookup("Draft", [svc, shared]).kind, "miss");
  assert.equal(lookup("back", [svc, shared]).kind, "miss", "case differs — suggestion only");
});

test("search finds either side and shows needs-review but hides superseded", () => {
  const [svc, shared] = loadCatalogues("demo");
  svc.add({ english: "Sign out", welsh: "Allgofnodi", source: "WLU" });
  svc.add({ english: "Sign out", welsh: "Allgofnodi o'r cyfrif", source: "WLU-2" });
  svc.add({ english: "Draft", welsh: "Drafft", source: "legacy", status: "needs-review" });
  assert.deepEqual(
    search("allgofnodi", [svc, shared], "contains", false).map((h) => h.welsh),
    ["Allgofnodi o'r cyfrif"]
  );
  assert.equal(search("allgofnodi", [svc, shared], "contains", true).length, 2);
  assert.equal(search("Draft", [svc, shared], "exact", false)[0].status, "needs-review");
});
