/**
 * Service clones and throwaway worktrees.
 *
 * Changes are always made in a temporary worktree off the remote default
 * branch, never in a checkout someone is using: on a laptop that is the
 * engineer's working copy, and in a CFT Workspace pod it is the
 * cft-workspace checkout every chat session shares, which the pod only
 * fast-forwards while it stays on its default branch.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { defaultBranch, git } from "./git.ts";
import { workspace } from "./paths.ts";
import { findTool, tool } from "./tools.ts";

/** The clone at a workspace-relative path, cloned from workspace.yaml first if it is not there yet. */
export function ensureClone(relPath: string): string {
  const abs = resolve(workspace(), relPath);
  if (existsSync(join(abs, ".git"))) {
    return abs;
  }
  if (existsSync(abs)) {
    return abs;
  }
  const url = manifestUrl(relPath);
  if (!url) {
    throw new Error(`${relPath} is not cloned and is not in workspace.yaml`);
  }
  // gh when there is one, for its sign-in; git over SSH otherwise.
  const ghPath = findTool("gh");
  const gh = ghPath === null ? null : spawnSync(ghPath, ["repo", "clone", url, abs, "--", "--filter=blob:none"], { encoding: "utf8" });
  if (gh?.status !== 0) {
    const ssh = spawnSync(tool("git"), ["clone", "--filter=blob:none", `git@github.com:${url}.git`, abs], { encoding: "utf8" });
    if (ssh.status !== 0) {
      throw new Error(`could not clone ${url}: ${(gh?.stderr || ssh.stderr).trim()}`);
    }
  }
  return abs;
}

/** One repo's entry in workspace.yaml, as either form the manifest allows: `{ url: … }` on one line, or one key a line. */
export interface ManifestEntry {
  url?: string;
}

/** workspace.yaml's repos, by workspace path; none when there is no manifest or it cannot be read. */
export function manifestEntries(): Record<string, ManifestEntry> {
  const manifest = join(workspace(), "workspace.yaml");
  if (!existsSync(manifest)) {
    return {};
  }
  try {
    const repos = (YAML.parse(readFileSync(manifest, "utf8")) as { repos?: unknown } | null)?.repos;
    return repos && typeof repos === "object" ? (repos as Record<string, ManifestEntry>) : {};
  } catch {
    return {};
  }
}

/** `<org>/<repo>` for a path in workspace.yaml, or null. */
export function manifestUrl(relPath: string): string | null {
  const url = manifestEntries()[relPath]?.url;
  return typeof url === "string" && url !== "" ? url : null;
}

/**
 * A new branch checked out in a scratch directory, starting from the remote's
 * default branch so it carries none of the local checkout's state.
 */
export function tempWorktree(repo: string, branch: string): Worktree {
  git(repo, ["fetch", "--quiet", "origin"], true);
  const base = defaultBranch(repo);
  const start = git(repo, ["rev-parse", "--verify", "--quiet", `origin/${base}`], true) ? `origin/${base}` : "HEAD";
  if (git(repo, ["branch", "--list", branch])) {
    throw new Error(`branch ${branch} already exists in ${repo}`);
  }
  const dir = join(mkdtempSync(join(tmpdir(), "welsh-wt-")), "tree");
  git(repo, ["worktree", "add", "--quiet", "-b", branch, dir, start]);
  return {
    dir,
    base,
    remove(keepBranch: boolean) {
      git(repo, ["worktree", "remove", "--force", dir], true);
      if (!keepBranch) {
        git(repo, ["branch", "-D", branch], true);
      }
    }
  };
}

/**
 * The remote's default branch, checked out detached in a scratch directory, for reading: a scan must see the code a
 * pull request would change, not a local checkout that may be behind it or carry someone's work in progress. Falls
 * back to the checkout itself when it is not a git clone.
 */
export function latestTree(repo: string): { dir: string; remove(): void } {
  if (!existsSync(join(repo, ".git"))) {
    return { dir: repo, remove() {} };
  }
  git(repo, ["fetch", "--quiet", "origin"], true);
  const base = defaultBranch(repo);
  const start = git(repo, ["rev-parse", "--verify", "--quiet", `origin/${base}`], true) ? `origin/${base}` : "HEAD";
  const dir = join(mkdtempSync(join(tmpdir(), "welsh-scan-")), "tree");
  git(repo, ["worktree", "add", "--quiet", "--detach", dir, start]);
  return { dir, remove: () => void git(repo, ["worktree", "remove", "--force", dir], true) };
}

export interface Worktree {
  dir: string;
  /** The default branch it started from, which a PR targets. */
  base: string;
  remove(keepBranch: boolean): void;
}
