import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A workspace whose cath home repo is a real clone of a scratch remote, so reads and changes go through git.
const ws = realpathSync(mkdtempSync(join(tmpdir(), "welsh-home-ws-")));
process.env.CFT_WELSH_WORKSPACE = ws;
writeFileSync(
  join(ws, "workspace.yaml"),
  "repos:\n  apps/cath/cath-docs: { url: hmcts/cath-docs }\n  apps/cath/cath-service: { url: hmcts/cath-service, welsh: true }\n  apps/pcs/pcs-api: { url: hmcts/pcs-api }\n"
);
const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const remote = join(ws, "remote.git");
sh(ws, "init", "--quiet", "--bare", "-b", "main", remote);
const clone = join(ws, "apps", "cath", "cath-service");
mkdirSync(join(ws, "apps", "cath"), { recursive: true });
sh(ws, "clone", "--quiet", remote, clone);
sh(clone, "config", "user.email", "t@example.com");
sh(clone, "config", "user.name", "Test");
mkdirSync(join(clone, "welsh"));
writeFileSync(join(clone, "welsh", "catalogue.csv"), "id,english,welsh,context,notes,source,received,status\nb1,Back,Yn ôl,,,WLU:1,2026-11-02,approved\n");
writeFileSync(join(clone, "welsh", "config.yaml"), "repos:\n  - path: .\n    adapters: [ts-locale-pair]\n");
sh(clone, "add", ".");
sh(clone, "commit", "--quiet", "-m", "welsh");
sh(clone, "push", "--quiet", "origin", "main");
sh(clone, "remote", "set-head", "origin", "main");
// Someone's unpushed work in the checkout, which nothing should read.
writeFileSync(join(clone, "welsh", "catalogue.csv"), "id,english,welsh,context,notes,source,received,status\n");

const { branchName, homeRepo, inHome, welshDir } = await import("../home.ts");
const { loadCatalogue } = await import("../catalogue.ts");
const { loadConfig } = await import("../config.ts");

test("homeRepo is the service's workspace.yaml entry marked welsh: true, and null when none is", () => {
  assert.equal(homeRepo("cath"), "apps/cath/cath-service");
  assert.equal(homeRepo("pcs"), null);
  assert.throws(() => welshDir("pcs"), /mark the repo that should hold it with `welsh: true`/);
});

test("the catalogue is read from the home repo's default branch, not the local checkout", () => {
  assert.equal(loadCatalogue("cath").approved("Back")[0]?.welsh, "Yn ôl");
  assert.notEqual(welshDir("cath"), join(clone, "welsh"));
});

test("a config's . is its own home repo", () => {
  assert.deepEqual(
    loadConfig("cath").repos.map((r) => r.path),
    ["apps/cath/cath-service"]
  );
});

test("a change runs in a worktree off the default branch and is committed on its own branch there", () => {
  const done = inHome<{ service: string; created: string[] }>("cath", ["init", "--service", "cath"], { branch: "welsh/cath-init", pr: false }, () => ({
    message: "Set up",
    title: "t",
    body: "b"
  }));
  assert.equal(done.branch, "welsh/cath-init");
  assert.equal(done.pr, null);
  assert.match(sh(clone, "show", "--stat", "--format=%s", "welsh/cath-init"), /welsh\/returns\/\.gitkeep/);
  assert.equal(sh(clone, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(readFileSync(join(clone, "welsh", "catalogue.csv"), "utf8").split("\n").length, 2, "the checkout is untouched");
});

test("a change that changes nothing commits nothing and leaves no branch", () => {
  sh(clone, "push", "--quiet", "origin", "welsh/cath-init:main");
  sh(clone, "fetch", "--quiet", "origin");
  const done = inHome("cath", ["init", "--service", "cath"], { branch: "welsh/cath-init-again", pr: false }, () => ({ message: "m", title: "t", body: "b" }));
  assert.equal(done.branch, null);
  assert.equal(sh(clone, "branch", "--list", "welsh/cath-init-again"), "");
});

test("homeRepo reads the manifest's one-key-a-line form too, and refuses two homes for one service", () => {
  const manifest = readFileSync(join(ws, "workspace.yaml"), "utf8");
  try {
    writeFileSync(join(ws, "workspace.yaml"), "repos:\n  apps/sscs/sscs-tribunals-frontend:\n    url: hmcts/sscs-tribunals-frontend\n    welsh: true\n");
    assert.equal(homeRepo("sscs"), "apps/sscs/sscs-tribunals-frontend");
    writeFileSync(
      join(ws, "workspace.yaml"),
      "repos:\n  apps/et/et-sya-frontend: { url: hmcts/et-sya-frontend, welsh: true }\n  apps/et/et-syr-frontend: { url: hmcts/et-syr-frontend, welsh: true }\n"
    );
    assert.throws(() => homeRepo("et"), /more than one repo marked welsh: true .*et-sya-frontend, apps\/et\/et-syr-frontend/);
  } finally {
    writeFileSync(join(ws, "workspace.yaml"), manifest);
  }
});

test("a change's branch is new each run, so a retry never meets the branch an earlier one left", () => {
  assert.equal(branchName("cath-Return 7", new Date("2026-11-02T16:12:05Z")), "welsh/cath-return-7-20261102-161205");
  assert.notEqual(branchName("cath-x", new Date("2026-11-02T16:12:05Z")), branchName("cath-x", new Date("2026-11-02T16:12:06Z")));
});
