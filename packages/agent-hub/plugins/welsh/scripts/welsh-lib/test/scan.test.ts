import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pageOf, scanCmd } from "../commands/scan.ts";
import { readTable } from "../xlsx.ts";

test("pageOf names a page by its folder, leaving out route groups and the usual source folders", () => {
  assert.equal(pageOf("apps/web/src/pages/(public)/summary-of-publications/cy.ts"), "summary of publications");
  assert.equal(pageOf("libs/list-types/siac-poac-paac-weekly-hearing-list/src/locales/cy.ts"), "siac poac paac weekly hearing list");
  assert.equal(pageOf("src/main/resources/locales/cy/case_details/cy.json"), "case details");
});

test("pageOf falls back to the file when every folder is a usual one", () => {
  assert.equal(pageOf("src/locales/cy.json"), "src/locales/cy.json");
});

/** A workspace with one cath repo whose Welsh is partly the English copied over, and the service's home welsh folder. */
function service(): { ws: string; repo: string } {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "welsh-scan-cmd-")));
  writeFileSync(join(ws, "workspace.yaml"), "repos: []\n");
  const repo = join(ws, "apps", "cath", "cath-service");
  const page = join(repo, "pages", "(public)", "upload");
  mkdirSync(page, { recursive: true });
  writeFileSync(
    join(page, "en.ts"),
    `export const en = { title: "Choose a file", locationLine1: "Rolls Building", errorHref: "#file", back: "Back", extra: "Upload documents" };\n`
  );
  writeFileSync(join(page, "cy.ts"), `export const cy = { title: "Choose a file", locationLine1: "Rolls Building", errorHref: "#file", back: "Back" };\n`);
  const welsh = join(ws, "home", "welsh");
  mkdirSync(welsh, { recursive: true });
  writeFileSync(join(welsh, "config.yaml"), "repos:\n  - path: apps/cath/cath-service\n    adapters: [ts-locale-pair]\n");
  writeFileSync(join(welsh, "catalogue.csv"), "id,english,welsh,context,notes,source,received,status\nb1,Back,Yn ôl,,,WLU:1,2026-11-02,approved\n");
  process.env.CFT_WELSH_WORKSPACE = ws;
  process.env.CFT_WELSH_HOME = welsh;
  return { ws, repo };
}

interface Scanned {
  toWlu: { ref: string; english: string; page: string; hint: string | null; keepable: boolean }[];
  fromCatalogue: { english: string; welsh: string; page: string }[];
  left_out: number;
  request: string | null;
}

test("scan says why a new string probably needs no Welsh, whether it can be kept, and never finds a link to the page", async () => {
  const { repo } = service();
  const result = (await scanCmd(["--service", "cath", "--repo", repo])) as Scanned;
  const byEnglish = Object.fromEntries(result.toWlu.map((s) => [s.english, s]));
  assert.deepEqual(
    Object.keys(byEnglish).sort((a, b) => (a < b ? -1 : Number(a > b))),
    ["Choose a file", "Rolls Building", "Upload documents"]
  );
  assert.match(byEnglish["Rolls Building"]?.hint ?? "", /address/);
  assert.equal(byEnglish["Rolls Building"]?.keepable, true);
  assert.equal(byEnglish["Choose a file"]?.hint, null);
  assert.equal(byEnglish["Upload documents"]?.keepable, false, "a key with no Welsh at all");
  assert.equal(byEnglish["Choose a file"]?.page, "upload");
  assert.deepEqual(
    result.fromCatalogue.map(({ english, welsh, page }) => ({ english, welsh, page })),
    [{ english: "Back", welsh: "Yn ôl", page: "upload" }]
  );
  assert.equal(result.request, null, "no spreadsheet unless asked for");
});

test("scan writes the request without the strings a BA left out", async () => {
  const { ws, repo } = service();
  const out = join(ws, "request.xlsx");
  const first = (await scanCmd(["--service", "cath", "--repo", repo])) as Scanned;
  const rolls = first.toWlu.find((s) => s.english === "Rolls Building")?.ref ?? "";
  const result = (await scanCmd(["--service", "cath", "--repo", repo, "--limit", "0", "--leave-out", rolls, "--out", out])) as Scanned;
  assert.equal(result.left_out, 1);
  assert.deepEqual(result.toWlu, []);
  const table = await readTable(out);
  assert.deepEqual(
    table.records.map((r) => r.english).sort((a, b) => (a < b ? -1 : Number(a > b))),
    ["Choose a file", "Upload documents"]
  );
});
