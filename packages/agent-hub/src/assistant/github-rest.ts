// GitHub's REST API as the supervisor reads a template library with it: the commit a ref is at, revalidated by ETag
// so an unchanged library costs nothing, the templates in a folder of that commit's tree, and a blob's bytes. Ported
// from the HMCTS Template Preview extension's library client (dtsse-docmosis-tools `vscode/src/library/github.ts`),
// as functions. The token is the owner's own `gh` sign-in, read for each call and only ever put in a header: it is
// never logged, printed or written, and no error says it.
import type { Env } from "../env.ts";
import { GITHUB_OWNER_RE, GITHUB_REPO_RE } from "../github.ts";
import type { Run } from "./lookups.ts";

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export type GithubFailureReason = "signed_out" | "sso" | "not_found" | "rate_limited" | "failed";

/** Why GitHub answered nothing usable, in the hub's terms: see "Docmosis template library" in docs/agent-api.md. */
export type GithubFailure = { error: GithubFailureReason; detail: string; sso_url?: string; reset_at?: string };

export class GithubRestError extends Error {
  readonly failure: GithubFailure;

  constructor(failure: GithubFailure) {
    super(failure.detail);
    this.name = "GithubRestError";
    this.failure = failure;
  }
}

/** How to reach GitHub: the fetch, the token, and a signal that cancels every request made with it. */
export type GithubRest = { fetch: FetchLike; token: string; api?: string; signal?: AbortSignal; timeoutMs?: number };

export type TreeEntry = { path: string; mode?: string; type: "blob" | "tree" | "commit"; sha: string; size?: number };
export type Tree = { sha: string; tree: TreeEntry[]; truncated: boolean };
export type CommitCheck = { modified: false; etag: string | null } | { modified: true; sha: string; etag: string | null };
export type Template = { path: string; sha: string; size: number };

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const WALK_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 15_000;
const SHA1_RE = /^[0-9a-f]{40}$/;
// A ref as a path segment: `HEAD`, a branch or a tag, never climbing with `..`.
const REF_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

export function isGitSha(value: unknown): value is string {
  return typeof value === "string" && SHA1_RE.test(value);
}

export function isGitRef(value: unknown): value is string {
  return typeof value === "string" && REF_RE.test(value) && !value.startsWith("/") && !value.endsWith("/");
}

/** The owner's GitHub token from the pod's `gh`, or null when it has none. Never logged. */
export async function githubToken(run: Run, env: Env): Promise<string | null> {
  const result = await run("gh", ["auth", "token", "--hostname", "github.com"], { env, timeoutMs: TOKEN_TIMEOUT_MS });
  const token = result.code === 0 ? result.stdout.trim() : "";
  return token === "" || /\s/.test(token) ? null : token;
}

function repoPath(owner: string, repo: string): string {
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(`${owner}/${repo}`)) {
    throw new GithubRestError({ error: "failed", detail: "That is not a GitHub repository." });
  }
  return `/repos/${owner}/${repo}`;
}

/** The SSO link is opened in the person's browser, so only an https page on github.com is kept. */
function githubPage(candidate: string | undefined): string | undefined {
  if (!candidate || !URL.canParse(candidate)) {
    return undefined;
  }
  const { protocol, hostname } = new URL(candidate);
  return protocol === "https:" && hostname === "github.com" ? candidate : undefined;
}

/** What a refusal from GitHub means for the person, as one of the hub's reasons. */
export function errorFor(response: Pick<Response, "status" | "statusText" | "headers">, repo: string, now: number = Date.now()): GithubFailure {
  const { status, headers } = response;
  if (status === 401) {
    return { error: "signed_out", detail: "GitHub rejected your assistant's GitHub sign-in. Sign in to GitHub again." };
  }
  const sso = headers.get("x-github-sso");
  if (status === 403 && sso) {
    const url = githubPage(/url=([^;\s]+)/.exec(sso)?.[1]);
    return {
      error: "sso",
      detail: `Your GitHub sign-in isn't authorised for the organisation that owns ${repo}. Authorise it for single sign-on.`,
      ...(url === undefined ? {} : { sso_url: url })
    };
  }
  if (status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after")))) {
    // retry-after comes with a secondary limit, which applies even when the primary limit has requests left.
    const retry = Number(headers.get("retry-after"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    const resetAt =
      Number.isFinite(retry) && retry > 0 ? new Date(now + retry * 1000) : Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
    return {
      error: "rate_limited",
      detail: "Your GitHub rate limit is used up for now.",
      ...(resetAt === undefined ? {} : { reset_at: resetAt.toISOString() })
    };
  }
  if (status === 404) {
    return { error: "not_found", detail: `${repo} doesn't exist, or your GitHub account can't see it.` };
  }
  return { error: "failed", detail: `GitHub answered ${status}${response.statusText ? ` ${response.statusText}` : ""} for ${repo}.` };
}

async function request(
  gh: GithubRest,
  route: string,
  accept: string,
  repo: string,
  extra: Record<string, string> = {},
  signal?: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {
    accept,
    "x-github-api-version": API_VERSION,
    "user-agent": "hmcts-agent-hub",
    authorization: `Bearer ${gh.token}`,
    ...extra
  };
  const signals = [AbortSignal.timeout(gh.timeoutMs ?? REQUEST_TIMEOUT_MS), ...(gh.signal ? [gh.signal] : []), ...(signal ? [signal] : [])];
  let response: Response;
  try {
    response = await gh.fetch(`${gh.api ?? API}${route}`, { headers, signal: AbortSignal.any(signals) });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new GithubRestError({ error: "failed", detail: `Your assistant can't reach GitHub: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (response.ok || response.status === 304) {
    return response;
  }
  throw new GithubRestError(errorFor(response, repo));
}

/** The commit `ref` is at, or that it is still the one `etag` was given for. */
export async function commitCheck(gh: GithubRest, owner: string, repo: string, ref: string, etag: string | null): Promise<CommitCheck> {
  if (!isGitRef(ref)) {
    throw new GithubRestError({ error: "failed", detail: "That is not a git ref." });
  }
  const name = `${owner}/${repo}`;
  const response = await request(
    gh,
    `${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}`,
    "application/vnd.github.sha",
    name,
    etag ? { "if-none-match": etag } : {}
  );
  const tag = response.headers.get("etag");
  if (response.status === 304) {
    return { modified: false, etag: tag };
  }
  const sha = (await response.text()).trim();
  if (!isGitSha(sha)) {
    throw new GithubRestError({ error: "failed", detail: `GitHub did not say which commit ${name} is at.` });
  }
  return { modified: true, sha, etag: tag };
}

export async function tree(gh: GithubRest, owner: string, repo: string, sha: string, recursive: boolean, signal?: AbortSignal): Promise<Tree> {
  if (!isGitSha(sha)) {
    throw new GithubRestError({ error: "failed", detail: "That is not a git tree." });
  }
  const route = `${repoPath(owner, repo)}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`;
  const response = await request(gh, route, "application/vnd.github+json", `${owner}/${repo}`, {}, signal);
  const body = (await response.json()) as Partial<Tree> | null;
  if (body === null || !Array.isArray(body.tree)) {
    throw new GithubRestError({ error: "failed", detail: `GitHub answered a tree of ${owner}/${repo} that is not one.` });
  }
  return { sha: String(body.sha ?? sha), tree: body.tree, truncated: body.truncated === true };
}

/** A blob's raw bytes, by its git SHA-1. */
export async function blob(gh: GithubRest, owner: string, repo: string, sha: string): Promise<Uint8Array> {
  if (!isGitSha(sha)) {
    throw new GithubRestError({ error: "failed", detail: "That is not a git blob." });
  }
  const response = await request(gh, `${repoPath(owner, repo)}/git/blobs/${sha}`, "application/vnd.github.raw", `${owner}/${repo}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** A blob the listing keeps: a .docx under the folder, skipping Word's `~$` lock files. */
function isTemplate(file: string, prefix: string): boolean {
  if (prefix && !file.startsWith(`${prefix}/`)) {
    return false;
  }
  const name = file.slice(file.lastIndexOf("/") + 1);
  return name.toLowerCase().endsWith(".docx") && !name.startsWith("~$");
}

function toTemplates(entries: readonly TreeEntry[], base: string, prefix: string): Template[] {
  const out: Template[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob" || typeof entry.path !== "string" || !isGitSha(entry.sha)) {
      continue;
    }
    const file = base ? `${base}/${entry.path}` : entry.path;
    if (isTemplate(file, prefix)) {
      out.push({ path: file, sha: entry.sha, size: typeof entry.size === "number" && entry.size >= 0 ? entry.size : 0 });
    }
  }
  return out;
}

/**
 * Every template under `prefix` at commit `sha`, in code-point order. One recursive tree call covers most repos; when
 * GitHub truncates it, the folders under `prefix` are walked one tree at a time, `WALK_CONCURRENCY` at once, and the
 * first failure fails the walk.
 */
export async function templates(gh: GithubRest, owner: string, repo: string, sha: string, prefix: string): Promise<Template[]> {
  const full = await tree(gh, owner, repo, sha, true);
  if (!full.truncated) {
    return toTemplates(full.tree, "", prefix).sort(byPath);
  }
  let root = await tree(gh, owner, repo, sha, false);
  for (const part of prefix ? prefix.split("/") : []) {
    const next = root.tree.find((entry) => entry.type === "tree" && entry.path === part);
    if (!next) {
      return [];
    }
    root = await tree(gh, owner, repo, next.sha, false);
  }
  const found: Template[] = [];
  const queue: { sha: string; base: string }[] = [];
  const visit = (listing: Tree, base: string): void => {
    for (const entry of listing.tree) {
      if (entry.type === "tree") {
        queue.push({ sha: entry.sha, base: base ? `${base}/${entry.path}` : entry.path });
      }
    }
    found.push(...toTemplates(listing.tree, base, prefix));
  };
  visit(root, prefix);
  // The first failure stops the other workers taking folders and cancels their requests.
  const stop = new AbortController();
  const worker = async (): Promise<void> => {
    try {
      while (!stop.signal.aborted) {
        const item = queue.shift();
        if (!item) {
          return;
        }
        visit(await tree(gh, owner, repo, item.sha, false, stop.signal), item.base);
      }
    } catch (error) {
      stop.abort();
      throw error;
    }
  };
  // Workers that find the queue empty exit early, so more are started while folders are still queued.
  while (queue.length > 0) {
    await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, queue.length) }, worker));
  }
  return found.sort(byPath);
}

function byPath(a: Template, b: Template): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
