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
  "repos:\n  apps/cath/cath-docs: { url: hmcts/cath-docs }\n  apps/cath/cath-service: { url: hmcts/cath-service }\n  apps/pcs/pcs-api: { url: hmcts/pcs-api }\n"
);
// The service's other repos, present and with no welsh/ folder.
mkdirSync(join(ws, "apps", "cath", "cath-docs"), { recursive: true });
mkdirSync(join(ws, "apps", "pcs", "pcs-api"), { recursive: true });
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

test("homeRepo is whichever of the service's repos has welsh/config.yaml on its default branch, and null when none has", () => {
  assert.equal(homeRepo("cath"), "apps/cath/cath-service");
  assert.equal(homeRepo("pcs"), null);
  assert.throws(() => welshDir("pcs"), /none of its repos has a welsh\/config.yaml.*welsh init --service pcs --repo apps\/pcs\/<repo>/);
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

test("homeRepo reads the manifest's one-key-a-line form too, and refuses a welsh/ folder in two repos", () => {
  const manifest = readFileSync(join(ws, "workspace.yaml"), "utf8");
  const withWelsh = (path: string) => {
    mkdirSync(join(ws, path, "welsh"), { recursive: true });
    writeFileSync(join(ws, path, "welsh", "config.yaml"), "repos: []\n");
  };
  try {
    withWelsh("apps/sscs/sscs-tribunals-frontend");
    writeFileSync(join(ws, "workspace.yaml"), "repos:\n  apps/sscs/sscs-tribunals-frontend:\n    url: hmcts/sscs-tribunals-frontend\n");
    assert.equal(homeRepo("sscs"), "apps/sscs/sscs-tribunals-frontend");
    withWelsh("apps/et/et-sya-frontend");
    withWelsh("apps/et/et-syr-frontend");
    writeFileSync(
      join(ws, "workspace.yaml"),
      "repos:\n  apps/et/et-sya-frontend: { url: hmcts/et-sya-frontend }\n  apps/et/et-syr-frontend: { url: hmcts/et-syr-frontend }\n"
    );
    assert.throws(() => homeRepo("et"), /a welsh\/ folder in more than one repo \(apps\/et\/et-sya-frontend, apps\/et\/et-syr-frontend\)/);
  } finally {
    writeFileSync(join(ws, "workspace.yaml"), manifest);
  }
});

test("homeRepo asks GitHub about a repo with no clone, cloning nothing, and says when GitHub cannot answer", () => {
  // A stand-in gh: found for one repo, not found for another, and a refused sign-in for the third.
  const bin = mkdtempSync(join(tmpdir(), "welsh-gh-"));
  writeFileSync(
    join(bin, "gh"),
    '#!/bin/sh\ncase "$*" in\n  *repos/hmcts/remote-app/contents/welsh/config.yaml*) exit 0 ;;\n  *repos/hmcts/no-welsh/*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;\n  *) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;\nesac\n',
    { mode: 0o755 }
  );
  const manifest = readFileSync(join(ws, "workspace.yaml"), "utf8");
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    writeFileSync(
      join(ws, "workspace.yaml"),
      "repos:\n  apps/remote/remote-app: { url: hmcts/remote-app }\n  apps/remote/no-welsh: { url: hmcts/no-welsh }\n  apps/locked/locked-app: { url: hmcts/locked-app }\n"
    );
    assert.equal(homeRepo("remote"), "apps/remote/remote-app");
    assert.throws(() => homeRepo("locked"), /could not check hmcts\/locked-app for a welsh\/ folder: HTTP 401: Bad credentials/);
  } finally {
    process.env.PATH = path;
    writeFileSync(join(ws, "workspace.yaml"), manifest);
  }
});

test("a change's branch is new each run, so a retry never meets the branch an earlier one left", () => {
  assert.equal(branchName("cath-Return 7", new Date("2026-11-02T16:12:05Z")), "welsh/cath-return-7-20261102-161205");
  assert.notEqual(branchName("cath-x", new Date("2026-11-02T16:12:05Z")), branchName("cath-x", new Date("2026-11-02T16:12:06Z")));
});
