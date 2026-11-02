/**
 * Where a service's Welsh lives: a welsh/ folder (catalogue.csv, config.yaml,
 * returns/) in one of its own repos, its home repo, which its workspace.yaml
 * entry marks with `welsh: true`:
 *
 *   apps/cath/cath-service: { url: hmcts/cath-service, welsh: true }
 *
 * The catalogue is read from the home repo's latest default branch, never a
 * local checkout that may be behind it or carry someone's work in progress,
 * and changed only through a branch in a temporary worktree of it, so a
 * catalogue change is reviewed in that repo like any other.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClone, tempWorktree } from "./clones.ts";
import { COMMIT_TRAILER, commit, defaultBranch, draftPr, git, PR_FOOTER } from "./git.ts";
import { WORKSPACE } from "./paths.ts";

/** This CLI, which a change runs again in its worktree. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

/** Set to a welsh/ folder to work in that one instead: what a change runs with, in its worktree. */
export const HOME_OVERRIDE = "CFT_WELSH_HOME";

/** A home repo fetched this recently is read as it is: a search runs once per keystroke on the Welsh page. */
const FRESH_MS = 60_000;

/** The workspace path of a service's home repo, or null when no entry under apps/<service>/ is marked. */
export function homeRepo(service: string): string | null {
  const manifest = join(WORKSPACE, "workspace.yaml");
  if (!existsSync(manifest)) {
    return null;
  }
  const prefix = `apps/${service}/`;
  for (const line of readFileSync(manifest, "utf8").split("\n")) {
    const entry = line.match(/^\s*([\w./-]+):\s*\{([^}]*)\}/);
    if (entry?.[1]?.startsWith(prefix) && /\bwelsh:\s*true\b/.test(entry[2] ?? "")) {
      return entry[1];
    }
  }
  return null;
}

/** Why a service has no Welsh yet, in words a developer can act on. */
export function noHome(service: string): string {
  return `${service} has no Welsh catalogue yet: mark the repo that should hold it with \`welsh: true\` in workspace.yaml, then run welsh init --service ${service}`;
}

const read = new Map<string, string>();

/**
 * The service's welsh/ folder to read: the override when a change is running,
 * otherwise the home repo's welsh/ folder from its latest default branch,
 * copied once per run into a scratch directory removed on exit. A home repo
 * that is not a git clone (a test's scratch tree) is read where it is.
 */
export function welshDir(service: string): string {
  const override = process.env[HOME_OVERRIDE];
  if (override) {
    return resolve(override);
  }
  const known = read.get(service);
  if (known !== undefined) {
    return known;
  }
  const home = homeRepo(service);
  if (home === null) {
    throw new Error(noHome(service));
  }
  const clone = ensureClone(home);
  let dir = join(clone, "welsh");
  if (existsSync(join(clone, ".git"))) {
    if (!fetchedRecently(clone)) {
      git(clone, ["fetch", "--quiet", "origin"], true);
    }
    const base = defaultBranch(clone);
    const ref = git(clone, ["rev-parse", "--verify", "--quiet", `origin/${base}`], true) ? `origin/${base}` : "HEAD";
    const scratch = mkdtempSync(join(tmpdir(), "welsh-home-"));
    process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));
    // Only the welsh/ folder, so a large repo costs no more than its catalogue. A home repo without one gives an
    // empty folder: the service is marked but not set up yet.
    const archive = spawnSync("git", ["-C", clone, "archive", "--format=tar", ref, "welsh"], { maxBuffer: 256 * 1024 * 1024 });
    if (archive.status === 0) {
      spawnSync("tar", ["-x", "-C", scratch], { input: archive.stdout });
    }
    dir = join(scratch, "welsh");
  }
  read.set(service, dir);
  return dir;
}

function fetchedRecently(clone: string): boolean {
  try {
    return Date.now() - statSync(join(clone, ".git", "FETCH_HEAD")).mtimeMs < FRESH_MS;
  } catch {
    return false;
  }
}

export interface HomeChange {
  /** The branch the change is committed on. */
  branch: string;
  /** Push and open a draft pull request; without it the commit stays on a local branch of the home repo's clone. */
  pr: boolean;
}

/** The commit and pull request for a change, in words, once its result says what it did. */
export interface HomeChangeText {
  message: string;
  title: string;
  body: string;
}

export interface HomeChanged<T> {
  result: T;
  /** The branch it is on, or null when it changed nothing. */
  branch: string | null;
  pr: string | null;
}

/**
 * Runs this same CLI command again in a fresh worktree of the service's home
 * repo, with the override pointing at its welsh/ folder, then commits what it
 * changed there. The command's own JSON is the result. Nothing is committed,
 * and the branch is removed, when it changed nothing.
 */
export function inHome<T>(service: string, argv: string[], change: HomeChange, describe: (result: T) => HomeChangeText): HomeChanged<T> {
  const home = homeRepo(service);
  if (home === null) {
    throw new Error(noHome(service));
  }
  const wt = tempWorktree(ensureClone(home), change.branch);
  let keep = false;
  try {
    const child = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI, ...argv], {
      encoding: "utf8",
      env: { ...process.env, [HOME_OVERRIDE]: join(wt.dir, "welsh") },
      maxBuffer: 64 * 1024 * 1024
    });
    process.stderr.write(child.stderr);
    if (child.status !== 0) {
      throw new Error(`${argv[0]} failed in the worktree (exit ${child.status})`);
    }
    const result = JSON.parse(child.stdout) as T;
    if (git(wt.dir, ["status", "--porcelain", "--", "welsh"]) === "") {
      return { result, branch: null, pr: null };
    }
    const text = describe(result);
    commit(wt.dir, ["welsh"], `${text.message}${COMMIT_TRAILER}`);
    keep = true;
    const pr = change.pr ? draftPr(wt.dir, text.title, `${text.body}${PR_FOOTER}`) : null;
    return { result, branch: change.branch, pr };
  } finally {
    wt.remove(keep);
  }
}

/** A branch name from a label, as git accepts it. */
export function branchName(label: string): string {
  return `welsh/${label}`.toLowerCase().replace(/[^a-z0-9/._-]+/g, "-");
}
