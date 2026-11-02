/**
 * Where a service's Welsh lives: a welsh/ folder (catalogue.csv, config.yaml,
 * returns/) in one of its own repos, its home repo. Nothing names it: the home
 * repo is whichever of the service's repos in workspace.yaml has
 * welsh/config.yaml on its default branch, so setting a service up is adding
 * that folder to its repo.
 *
 * The catalogue is read from the home repo's latest default branch, never a
 * local checkout that may be behind it or carry someone's work in progress,
 * and changed only through a branch in a temporary worktree of it, so a
 * catalogue change is reviewed in that repo like any other.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClone, manifestEntries, tempWorktree } from "./clones.ts";
import { COMMIT_TRAILER, commit, defaultBranch, draftPr, git, PR_FOOTER } from "./git.ts";
import { workspace } from "./paths.ts";

/** This CLI, which a change runs again in its worktree. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

/** Set to a welsh/ folder to work in that one instead: what a change runs with, in its worktree. */
export const HOME_OVERRIDE = "CFT_WELSH_HOME";

/** A home repo fetched this recently is read as it is: a search runs once per keystroke on the Welsh page. */
const FRESH_MS = 60_000;

/** A home repo found is trusted this long, and one not found is looked for again after the shorter wait. */
const FOUND_MS = 10 * 60_000;
const MISSING_MS = 60_000;

/**
 * The workspace path of a service's home repo: the one of its repos under apps/<service>/ in workspace.yaml with
 * welsh/config.yaml on its default branch, or null when none has. More than one is refused rather than one chosen,
 * since reads and pull requests would otherwise go to whichever came first. Looking costs a fetch or a GitHub call per
 * repo, and a search runs once per keystroke on the Welsh page, so the answer is kept for a while.
 */
export function homeRepo(service: string): string | null {
  const cacheFile = join(workspace(), "apps", service, ".welsh-work", "home.json");
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { home: string | null; at: number };
    if (Date.now() - cached.at < (cached.home === null ? MISSING_MS : FOUND_MS)) {
      return cached.home;
    }
  } catch {
    // Not looked for yet, or the note is unreadable: look again.
  }
  const prefix = `apps/${service}/`;
  const found = Object.entries(manifestEntries())
    .filter(([path, entry]) => path.startsWith(prefix) && hasWelsh(path, entry?.url))
    .map(([path]) => path);
  if (found.length > 1) {
    throw new Error(`${service} has a welsh/ folder in more than one repo (${found.join(", ")}); a service keeps its Welsh in one`);
  }
  const home = found[0] ?? null;
  if (existsSync(join(workspace(), "apps", service))) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ home, at: Date.now() }));
  }
  return home;
}

/**
 * Whether a repo has welsh/config.yaml on its default branch: asked of its clone when there is one, after a fetch, and
 * of GitHub otherwise, so finding a service's home repo clones nothing. A directory that is not a clone (a test's
 * scratch tree) is looked at as it is. Any GitHub answer but "not found", such as a sign-in that has run out, is said
 * rather than taken for a repo without Welsh.
 */
function hasWelsh(path: string, url: string | undefined): boolean {
  const abs = resolve(workspace(), path);
  if (existsSync(join(abs, ".git"))) {
    if (!fetchedRecently(abs)) {
      git(abs, ["fetch", "--quiet", "origin"], true);
    }
    const base = defaultBranch(abs);
    const ref = git(abs, ["rev-parse", "--verify", "--quiet", `origin/${base}`], true) ? `origin/${base}` : "HEAD";
    return spawnSync("git", ["-C", abs, "cat-file", "-e", `${ref}:welsh/config.yaml`]).status === 0;
  }
  if (existsSync(abs)) {
    return existsSync(join(abs, "welsh", "config.yaml"));
  }
  if (!url) {
    return false;
  }
  const asked = spawnSync("gh", ["api", `repos/${url}/contents/welsh/config.yaml`, "--silent"], { encoding: "utf8" });
  if (asked.status === 0) {
    return true;
  }
  if (/HTTP 404|Not Found/i.test(`${asked.stderr}${asked.stdout}`)) {
    return false;
  }
  throw new Error(`could not check ${url} for a welsh/ folder: ${(asked.stderr || asked.stdout || String(asked.error ?? "")).trim()}`);
}

/** Why a service has no Welsh yet, in words a developer can act on. */
export function noHome(service: string): string {
  return `${service} has no Welsh catalogue yet: none of its repos has a welsh/config.yaml. Set one up with welsh init --service ${service} --repo apps/${service}/<repo> --pr`;
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
    // empty folder: the service is marked but not set up yet. Any other failure, such as a sign-in a partial clone
    // needs to fetch the files, is said as it is rather than taken for a service with no Welsh.
    const archive = spawnSync("git", ["-C", clone, "archive", "--format=tar", ref, "welsh"], { maxBuffer: 256 * 1024 * 1024 });
    if (archive.status !== 0) {
      const why = archive.stderr.toString().trim();
      if (!/did not match any files|pathspec 'welsh'/.test(why)) {
        throw new Error(`could not read welsh/ from ${home}: ${why}`);
      }
    } else {
      const tar = spawnSync("tar", ["-x", "-C", scratch], { input: archive.stdout });
      if (tar.status !== 0) {
        throw new Error(`could not unpack welsh/ from ${home}: ${tar.stderr.toString().trim()}`);
      }
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
  /** The repo to make it in, when the service has no home repo yet: what `init --repo` sets up. */
  repo?: string;
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
  const home = homeRepo(service) ?? change.repo ?? null;
  if (home === null) {
    throw new Error(noHome(service));
  }
  if (change.repo !== undefined && change.repo !== home) {
    throw new Error(`${service}'s Welsh is already in ${home}, not ${change.repo}`);
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
    // A PR that could not be opened takes its branch with it, so running the command again starts clean.
    const pr = change.pr ? draftPr(wt.dir, text.title, `${text.body}${PR_FOOTER}`) : null;
    keep = true;
    return { result, branch: change.branch, pr };
  } finally {
    wt.remove(keep);
  }
}

/**
 * A branch name from a label, as git accepts it, made unique with the time, so running a change again never meets the
 * branch an earlier run left behind.
 */
export function branchName(label: string, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `welsh/${label}-${stamp}`.toLowerCase().replace(/[^a-z0-9/._-]+/g, "-");
}
