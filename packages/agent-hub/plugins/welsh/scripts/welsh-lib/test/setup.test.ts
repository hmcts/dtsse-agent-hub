import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";

// A workspace where pcs has two repos and no Welsh yet, one of them a real clone of a scratch remote. No entry has a
// GitHub url, so nothing here asks GitHub.
const ws = realpathSync(mkdtempSync(join(tmpdir(), "welsh-setup-ws-")));
process.env.CFT_WELSH_WORKSPACE = ws;
writeFileSync(join(ws, "workspace.yaml"), "repos:\n  apps/pcs/pcs-frontend: {}\n  apps/pcs/pcs-api: {}\n  apps/cath/cath-service: {}\n");
mkdirSync(join(ws, "apps", "pcs", "pcs-api"), { recursive: true });
mkdirSync(join(ws, "apps", "cath", "cath-service", "welsh"), { recursive: true });
writeFileSync(join(ws, "apps", "cath", "cath-service", "welsh", "config.yaml"), "repos: []\n");
const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const remote = join(ws, "remote.git");
sh(ws, "init", "--quiet", "--bare", "-b", "main", remote);
const clone = join(ws, "apps", "pcs", "pcs-frontend");
sh(ws, "clone", "--quiet", remote, clone);
sh(clone, "config", "user.email", "t@example.com");
sh(clone, "config", "user.name", "Test");
writeFileSync(join(clone, "README.md"), "pcs\n");
sh(clone, "add", ".");
sh(clone, "commit", "--quiet", "-m", "first");
sh(clone, "push", "--quiet", "origin", "main");
sh(clone, "remote", "set-head", "origin", "main");

const files = mkdtempSync(join(tmpdir(), "welsh-setup-files-"));
async function sheet(name: string, rows: string[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const row of rows) {
    ws.addRow(row);
  }
  const path = join(files, name);
  await wb.xlsx.writeFile(path);
  return path;
}
const first = await sheet("first.xlsx", [["Catalogue of approved Welsh"], ["English text", "Welsh text"], ["Continue", "Parhau"], ["Back", "Yn ôl"]]);
const second = await sheet("second.xlsx", [
  ["English", "Cymraeg"],
  ["Back", "Nôl"],
  ["Sign out", "Allgofnodi"]
]);
const noHeadings = await sheet("notes.xlsx", [
  ["Saesneg", "Cymraeg"],
  ["Continue", "Parhau"]
]);
const copy = join(files, "copy.json");
writeFileSync(copy, JSON.stringify({ Continue: "Parhau", Cancel: "Canslo" }));

const { serviceRepos, setupCmd, unreadableSources } = await import("../commands/setup.ts");
const { legacySources } = await import("../commands/catalogue.ts");

test("a service's repos are its workspace.yaml entries, in order", () => {
  assert.deepEqual(serviceRepos("pcs"), ["apps/pcs/pcs-api", "apps/pcs/pcs-frontend"]);
});

test("a dry run reads every file into a catalogue that is thrown away, and names one it cannot read", async () => {
  const result = (await setupCmd([
    "--service",
    "pcs",
    "--repo",
    "apps/pcs/pcs-frontend",
    "--xlsx",
    first,
    "--xlsx",
    second,
    "--xlsx",
    noHeadings,
    "--json",
    copy,
    "--dry-run"
  ])) as Record<string, unknown>;
  assert.equal(result.dryRun, true);
  assert.equal(result.sources, 3, "the unreadable file is left out");
  assert.equal(result.conflicts, 1, "Back has two renderings");
  assert.deepEqual(
    (result.conflictExamples as { english: string }[]).map((c) => c.english),
    ["Back"]
  );
  assert.deepEqual(
    (result.unreadable as { file: string }[]).map((u) => u.file),
    ["notes.xlsx"]
  );
  assert.equal(sh(clone, "branch", "--list", "welsh/*"), "", "nothing is committed");
});

test("setting up commits welsh/ with the seeded catalogue on a branch of the chosen repo", async () => {
  const result = (await setupCmd(["--service", "pcs", "--repo", "apps/pcs/pcs-frontend", "--xlsx", first, "--json", copy])) as Record<string, unknown>;
  assert.equal(result.repo, "apps/pcs/pcs-frontend");
  assert.equal(result.pr, null);
  const branch = String(result.branch);
  assert.match(branch, /^welsh\/pcs-setup-/);
  const tree = sh(clone, "ls-tree", "-r", "--name-only", branch, "welsh");
  assert.deepEqual(tree.split("\n").sort(), [
    "welsh/catalogue.csv",
    "welsh/config.yaml",
    "welsh/needs-review.md",
    "welsh/returns/.gitkeep",
    "welsh/sources/copy.json",
    "welsh/sources/first.xlsx"
  ]);
  assert.deepEqual(result.saved, ["first.xlsx", "copy.json"]);
  assert.equal(sh(clone, "show", `${branch}:welsh/sources/copy.json`), JSON.stringify({ Continue: "Parhau", Cancel: "Canslo" }));
  const catalogue = sh(clone, "show", `${branch}:welsh/catalogue.csv`);
  assert.match(catalogue, /Continue,Parhau/);
  assert.match(catalogue, /Cancel,Canslo/);
  assert.equal(sh(clone, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the checkout is untouched");
});

test("setting up with no earlier translations adds an empty catalogue", async () => {
  const result = (await setupCmd(["--service", "pcs", "--repo", "apps/pcs/pcs-frontend"])) as Record<string, unknown>;
  assert.equal(result.sources, 0);
  assert.equal(sh(clone, "show", `${String(result.branch)}:welsh/catalogue.csv`).split("\n").length, 1);
});

test("setting up refuses a file it cannot read, a repo that is not the service's, and a service already set up", async () => {
  await assert.rejects(setupCmd(["--service", "pcs", "--repo", "apps/pcs/pcs-frontend", "--xlsx", noHeadings]), /notes\.xlsx \(no sheet has both/);
  await assert.rejects(setupCmd(["--service", "pcs", "--repo", "apps/cath/cath-service"]), /must be one of pcs's repos/);
  await assert.rejects(setupCmd(["--service", "pcs"]), /--repo is required/);
  await assert.rejects(setupCmd(["--service", "cath", "--repo", "apps/cath/cath-service"]), /already set up for Welsh, in apps\/cath\/cath-service/);
});

test("two documents with one name are both kept, the second with a number", async () => {
  const { saveSources } = await import("../commands/setup.ts");
  const other = mkdtempSync(join(tmpdir(), "welsh-setup-other-"));
  writeFileSync(join(other, "copy.json"), "{}");
  const welsh = mkdtempSync(join(tmpdir(), "welsh-setup-kept-"));
  assert.deepEqual(saveSources(welsh, legacySources([], [copy, join(other, "copy.json")])), ["copy.json", "copy (2).json"]);
});

test("a JSON copy that is not an object of English to Welsh is named", async () => {
  const list = join(files, "list.json");
  writeFileSync(list, "[]");
  assert.deepEqual(await unreadableSources(legacySources([], [list])), [{ file: "list.json", problem: "it is not a JSON object of English to Welsh" }]);
  const nested = join(files, "cy.json");
  writeFileSync(nested, JSON.stringify({ Back: "Yn ôl", page: { title: "Teitl" } }));
  assert.deepEqual(await unreadableSources(legacySources([], [nested])), [
    { file: "cy.json", problem: 'it is not a flat list of English to Welsh: "page" holds more than one piece of text' }
  ]);
});
