import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keepEnglishCmd } from "../commands/keep.ts";

const CONFIG = "# Settings.\nrepos:\n  - path: .\n    adapters: [ts-locale-pair]\n\n# English that is the same in Welsh.\nidentical_allowlist: [ServiceNow]\n";

/** A workspace with a cath product, and its welsh folder as the home the command writes to. */
function home(): string {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "welsh-keep-")));
  writeFileSync(join(ws, "workspace.yaml"), "repos: []\n");
  mkdirSync(join(ws, "apps", "cath"), { recursive: true });
  const welsh = join(ws, "home", "welsh");
  mkdirSync(welsh, { recursive: true });
  writeFileSync(join(welsh, "config.yaml"), CONFIG);
  process.env.CFT_WELSH_WORKSPACE = ws;
  process.env.CFT_WELSH_HOME = welsh;
  return welsh;
}

test("keep-english adds new English to identical_allowlist once, keeping the file's comments and style", async () => {
  const welsh = home();
  const result = (await keepEnglishCmd(["--service", "cath", "--", "Rolls Building", "ServiceNow", "Rolls Building "])) as { added: string[]; already: number };
  assert.deepEqual(result.added, ["Rolls Building"]);
  assert.equal(result.already, 1);
  const text = readFileSync(join(welsh, "config.yaml"), "utf8");
  assert.match(text, /# English that is the same in Welsh\./);
  assert.match(text, /adapters: \[ts-locale-pair\]/);
  assert.match(text, /identical_allowlist:\n {2}- ServiceNow\n {2}- Rolls Building\n/);
});

test("keep-english changes nothing on a dry run", async () => {
  const welsh = home();
  const result = (await keepEnglishCmd(["--service", "cath", "--dry-run", "--", "Rolls Building"])) as { added: string[] };
  assert.deepEqual(result.added, ["Rolls Building"]);
  assert.equal(readFileSync(join(welsh, "config.yaml"), "utf8"), CONFIG);
});

test("keep-english refuses a call with no English", async () => {
  home();
  await assert.rejects(keepEnglishCmd(["--service", "cath", "--"]), /give the English to keep/);
});

test("keep-english refuses a service whose welsh folder has no config yet", async () => {
  const welsh = home();
  rmSync(join(welsh, "config.yaml"));
  await assert.rejects(keepEnglishCmd(["--service", "cath", "--", "Rolls Building"]), /cath has no welsh\/config.yaml yet/);
});
