/**
 * Branch, commit and draft PR, for the workspace repo (catalogue changes) and
 * for service clones (applied translations). Callers decide when; the skill
 * confirms with the BA before anything is pushed.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "./tools.ts";

export function git(repo: string, args: string[], allowFail = false): string {
  const res = spawnSync(tool("git"), ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed in ${repo}: ${(res.stderr || res.stdout).trim()}`);
  }
  return res.stdout.trim();
}

export function currentBranch(repo: string): string {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function defaultBranch(repo: string): string {
  const head = git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], true);
  return head ? head.replace(/^origin\//, "") : "master";
}

export function commit(repo: string, paths: string[], message: string): string {
  git(repo, ["add", "--", ...paths]);
  const file = join(tmpdir(), `welsh-commit-${process.pid}.txt`);
  writeFileSync(file, message);
  git(repo, ["commit", "-F", file]);
  return git(repo, ["rev-parse", "--short", "HEAD"]);
}

/** Push the current branch and open a draft PR against the default branch. Returns the PR URL. */
export function draftPr(repo: string, title: string, body: string): string {
  const branch = currentBranch(repo);
  git(repo, ["push", "-u", "origin", branch]);
  const file = join(tmpdir(), `welsh-pr-${process.pid}.md`);
  writeFileSync(file, body);
  const res = spawnSync(tool("gh"), ["pr", "create", "--draft", "--base", defaultBranch(repo), "--title", title, "--body-file", file], {
    cwd: repo,
    encoding: "utf8"
  });
  if (res.status !== 0) {
    throw new Error(`gh pr create failed: ${(res.stderr || res.stdout).trim()}`);
  }
  return res.stdout.trim().split("\n").pop() ?? "";
}
