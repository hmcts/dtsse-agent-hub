import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { jsonPair } from "../adapters/json-pair.ts";
import { tsLocalePair } from "../adapters/ts-locale-pair.ts";
import type { Leaf } from "../adapters/types.ts";
import { classify } from "../scan.ts";
import { tokenProblems } from "../tokens.ts";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "welsh-adapter-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

const signals = (leaves: Leaf[]) => Object.fromEntries(leaves.map((l) => [l.key, classify(l, [], new Set())]));

test("ts-locale-pair: reads nested keys, arrays, template functions and Cy-suffixed exports", () => {
  const dir = repo({
    "page/en.ts": `import { x } from "y";
export const en = {
  title: "Your appeal",
  nested: { hint: 'Enter a date', url: "https://www.gov.uk/" },
  list: ["One", "Two"],
  contact: (venue: string) => \`Contact \${venue} today\`,
  spread: x,
};
export const headers = { date: "Date" };
`,
    "page/cy.ts": `export const cy = {
  title: "[WELSH TRANSLATION REQUIRED: 'Your appeal']",
  nested: { hint: 'Enter a date', url: "https://www.gov.uk/" },
  list: ["Un"],
  contact: (venue: string) => \`Cysylltwch â \${venue} heddiw\`,
};
export const headersCy = { date: "Dyddiad" };
`
  });
  const leaves = tsLocalePair.extract(dir, ["page/en.ts", "page/cy.ts"], {});
  assert.deepEqual(signals(leaves), {
    "en.title": "marker",
    "en.nested.hint": "identical",
    "en.nested.url": null,
    "en.list.0": null,
    "en.list.1": "missing-key",
    "en.contact": null,
    "headers.date": null
  });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a ${…} placeholder in content is what this checks
  assert.equal(leaves.find((l) => l.key === "en.contact")?.english, "Contact ${venue} today");
});

test("ts-locale-pair: writes in place keeping quote style, and inserts missing nested keys", () => {
  const dir = repo({
    "en.ts": `export const en = {\n  title: "Title",\n  hint: 'It\\'s here',\n  errors: { required: "Required", tooLong: "Too long" },\n  greet: (n: string) => \`Hello \${n}\`,\n  extra: { deep: { label: "Label" } }\n};\n`,
    "cy.ts": `export const cy = {\n  title: "Title",\n  hint: 'It\\'s here',\n  errors: { required: "Gofynnol" },\n  greet: (n: string) => "Hello"\n};\n`
  });
  const leaves = tsLocalePair.extract(dir, ["en.ts", "cy.ts"], {});
  const by = (k: string) => leaves.find((l) => l.key === k)!;
  tsLocalePair.write(dir, [
    { leaf: by("en.title"), welsh: "Teitl" },
    { leaf: by("en.hint"), welsh: "Mae’n y fan hon" },
    { leaf: by("en.errors.tooLong"), welsh: "Rhy hir" },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a ${…} placeholder in content is what this checks
    { leaf: by("en.greet"), welsh: "Helo ${n}" },
    { leaf: by("en.extra.deep.label"), welsh: "Label CY" }
  ]);
  const out = readFileSync(join(dir, "cy.ts"), "utf8");
  assert.match(out, /title: "Teitl",/);
  assert.match(out, /hint: 'Mae’n y fan hon',/);
  assert.match(out, /errors: \{ required: "Gofynnol",\s*tooLong: "Rhy hir" \}/);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a ${…} placeholder in content is what this checks
  assert.match(out, /greet: \(n: string\) => `Helo \$\{n\}`/, "Welsh with ${} becomes a template literal");
  assert.match(out, /extra: \{ deep: \{ label: "Label CY" \} \}/);
  const again = tsLocalePair.extract(dir, ["en.ts", "cy.ts"], {});
  assert.deepEqual(Object.values(signals(again)).filter(Boolean), [], "nothing left to translate");
});

test("json-pair: i18next folders, single files and step files; writes keep English key order", () => {
  const dir = repo({
    "locales/en/common.json": JSON.stringify({ a: "Apple", b: "Banana {{count}}", c: { d: "Dog" } }, null, 2),
    "locales/cy/common.json": JSON.stringify({ a: "cyApple", c: {} }, null, 4),
    "i18n/en.json": JSON.stringify({ X: "Yes please" }),
    "steps/s1/content.en.json": JSON.stringify({ q: "Question" })
  });
  const files = ["locales/en/common.json", "locales/cy/common.json", "i18n/en.json", "steps/s1/content.en.json"];
  const leaves = jsonPair.extract(dir, files, {});
  assert.deepEqual(signals(leaves), { a: "placeholder", b: "missing-key", "c.d": "missing-key", X: "missing-file", q: "missing-file" });

  const by = (k: string) => leaves.find((l) => l.key === k)!;
  jsonPair.write(dir, [
    { leaf: by("b"), welsh: "Banana {{count}} CY" },
    { leaf: by("a"), welsh: "Afal" },
    { leaf: by("c.d"), welsh: "Ci" },
    { leaf: by("q"), welsh: "Cwestiwn" }
  ]);
  const cy = readFileSync(join(dir, "locales/cy/common.json"), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(cy)), ["a", "b", "c"], "b inserted between a and c, as in English");
  assert.match(cy, /^\{\n {4}"a"/, "keeps the Welsh file's own 4-space indent");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "steps/s1/content.cy.json"), "utf8")), { q: "Cwestiwn" });
});

test("json-pair: combined { en, cy } files", () => {
  const dir = repo({ "content.json": JSON.stringify({ en: { t: "Title", u: "Upload" }, cy: { t: "Teitl" } }) });
  const leaves = jsonPair.extract(dir, ["content.json"], { combined: ["content.json"] });
  assert.deepEqual(signals(leaves), { t: null, u: "missing-key" });
  jsonPair.write(dir, [{ leaf: leaves.find((l) => l.key === "u")!, welsh: "Llwytho i fyny" }]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "content.json"), "utf8")).cy, { t: "Teitl", u: "Llwytho i fyny" });
});

test("token check catches dropped, translated and invented placeholders across syntaxes", () => {
  assert.deepEqual(tokenProblems("Hello {{ name }}", "Helo {{name}}"), []);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a ${…} placeholder in content is what this checks
  assert.deepEqual(tokenProblems("Pay ${fee} by %{date}", "Talu erbyn %{date}"), ["missing ${fee}"]);
  assert.deepEqual(tokenProblems("Hi ((first_name))", "Helo ((enw_cyntaf))"), ["missing ((first_name))", "unexpected ((enw_cyntaf))"]);
  assert.deepEqual(tokenProblems("Contact {email}", "Cysylltwch â {email}"), []);
  assert.deepEqual(tokenProblems("Item {0} of {1}", "Eitem {0} o {1}"), []);
});

test("classify leaves URLs, acronyms and ids alone but flags copied English", () => {
  const leaf = (english: string, welsh: string | null): Leaf => ({
    adapter: "t",
    enFile: "e",
    cyFile: "c",
    key: "k",
    path: ["k"],
    english,
    welsh,
    tokens: "none"
  });
  assert.equal(classify(leaf("https://www.gov.uk", "https://www.gov.uk"), [], new Set()), null);
  assert.equal(classify(leaf("PNC ID", "PNC ID"), [], new Set()), null);
  assert.equal(classify(leaf("user-accounts", "user-accounts"), [], new Set()), null);
  assert.equal(classify(leaf("Back to top", "Back to top"), [], new Set()), "identical");
  assert.equal(classify(leaf("Strand, London", "Strand, London"), [], new Set(["Strand, London"])), null, "allowlisted");
  assert.equal(classify(leaf("Continue", "Welsh placeholder"), [], new Set()), "placeholder");
});

test("scanRepo skips pages marked staff_only, which need no Welsh", async () => {
  const { scanRepo } = await import("../scan.ts");
  const { Catalogue } = await import("../catalogue.ts");
  const empty = new Catalogue("demo", join(tmpdir(), "no-catalogue.csv"), []);
  const dir = repo({
    "pages/(public)/home/en.ts": `export const en = { title: "Find a hearing" };\n`,
    "pages/(public)/home/cy.ts": `export const cy = { title: "Find a hearing" };\n`,
    "pages/(system-admin)/users/en.ts": `export const en = { title: "Manage users" };\n`,
    "pages/(system-admin)/users/cy.ts": `export const cy = { title: "Welsh placeholder" };\n`
  });
  const config = { repos: [], identical_allowlist: [], placeholder_patterns: [], context_sensitive: [] };
  const all = scanRepo("demo", dir, { path: "x", adapters: ["ts-locale-pair"] }, config, empty);
  const publicOnly = scanRepo("demo", dir, { path: "x", adapters: ["ts-locale-pair"], staff_only: ["pages/(system-admin)/**"] }, config, empty);
  assert.deepEqual(
    all.map((f) => f.english).sort((a, b) => (a < b ? -1 : Number(a > b))),
    ["Find a hearing", "Manage users"]
  );
  assert.deepEqual(
    publicOnly.map((f) => f.english),
    ["Find a hearing"]
  );
});
