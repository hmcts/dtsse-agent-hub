/**
 * Where an agent's repo is on GitHub, built from the `repo` and `branch` its session registered. A body written in a
 * clone cites repo-relative paths, and this is what turns one into a URL a reader can open; `repoHref` in
 * `src/messages/markup.ts` resolves against what this returns.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

/** Every repo an agent registers is HMCTS's; settable so a fork or a test can name another owner. */
export const DEFAULT_GITHUB_ORG = "hmcts";

export function githubOrg(env: Environment = process.env): string {
  return env.GITHUB_ORG?.trim() || DEFAULT_GITHUB_ORG;
}

// GitHub's own rule for a repository name, which also rules out the `.` and `..` segments that would let a name
// reach out of its repo while staying on github.com.
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A ref as git will format one: slash-separated segments of characters that need no percent-encoding in a path.
// `check-ref-format` forbids a `..` anywhere in a ref, so rejecting one costs nothing and keeps a branch from
// resolving above the repo.
const REF = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * The `blob` URL a path inside the repo hangs off, or `null` when there is no repo or its name is not one GitHub
 * could serve. The trailing slash is what makes a relative path resolve inside the ref rather than beside it.
 *
 * A branch the agent did not report, or reported in a spelling no ref can have, falls back to `HEAD`: GitHub
 * resolves that to the repo's default branch, so the link survives the branch being merged and deleted — which a
 * named branch does not, and which is why carrying the commit is a follow-up rather than this.
 */
export function repoFileBase(repo: string | null, branch: string | null, env: Environment = process.env): string | null {
  if (repo === null || !REPO_NAME.test(repo)) {
    return null;
  }
  const ref = branch !== null && REF.test(branch) && !branch.split("/").includes("..") ? branch : "HEAD";
  return `https://github.com/${githubOrg(env)}/${repo}/blob/${ref}/`;
}
