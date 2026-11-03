// The supervisor's half of a GitHub lookup: a search of the repositories or the Projects the owner's own gh sign-in
// can see, for the HMCTS Assistant's document panel and settings to pick where a GitHub issue goes. A repository is
// where an issue lives; a Project is a board that shows issues from any number of repositories, so the two are
// searched apart. Fixed and read-only: one `gh` call whose every value is checked and passed as its own argument,
// never through a shell, and an answer cut down to the fields the hub accepts. See "Lookups" in dtsse-agent-hub's
// docs/agent-api.md.
import type { Env } from "../env.ts";
import type { GithubProjectFound, GithubRepoFound, LookupAnswer } from "../wire.ts";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (cmd: string, args: string[], opts: { env: Env; timeoutMs: number }) => Promise<RunResult>;

export const MAX_GITHUB_RESULTS = 10;
// The hub stops waiting after 10 seconds; a search still running past this is one nobody is waiting for.
const SEARCH_TIMEOUT_MS = 12000;
const OWNERS_TIMEOUT_MS = 8000;
const MAX_WORDS = 6;
const MAX_WORD = 40;
const MAX_DESCRIPTION = 300;
const MAX_TITLE = 200;
const MAX_DETAIL = 300;
// GitHub's search answers repositories with issues turned off too; asking for more leaves ten once those are dropped.
const SEARCH_LIMIT = 20;
// gh exits 4 when it has no usable sign-in.
const GH_EXIT_AUTH = 4;

/** A GitHub user or organisation login. */
export const GITHUB_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

// One query for an organisation's Projects or a user's: `repositoryOwner` answers either, and only the fragment for
// the kind it is fills in. Closed Projects are asked for and dropped here, since nobody files new work on one.
const PROJECTS_QUERY = `query($owner: String!, $q: String!) {
  repositoryOwner(login: $owner) {
    ... on Organization { projectsV2(first: 20, query: $q, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title closed } } }
    ... on User { projectsV2(first: 20, query: $q, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title closed } } }
  }
}`;

// One Project by its number, for a pasted link or a number typed on its own: a title search would not find either.
const PROJECT_QUERY = `query($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) {
    ... on Organization { projectV2(number: $number) { number title closed } }
    ... on User { projectV2(number: $number) { number title closed } }
  }
}`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The words of a query, as letters and digits only, so nothing typed can be read by gh as a flag or a qualifier. */
export function githubWords(query: string): string[] {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_WORDS).map((word) => word.slice(0, MAX_WORD));
}

/**
 * What a repository search looks for: the owner typed before a `/`, or pasted in a GitHub link, when there is one,
 * and the words of the name. `hmcts/ccd-data` is the words `ccd data` in `hmcts` alone.
 */
export function repoQuery(query: string): { owner: string | null; words: string[] } {
  const trimmed = query.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  const slash = trimmed.indexOf("/");
  const owner = slash > 0 ? trimmed.slice(0, slash) : null;
  if (owner !== null && GITHUB_OWNER_RE.test(owner)) {
    return { owner, words: githubWords(trimmed.slice(slash + 1)) };
  }
  return { owner: null, words: githubWords(trimmed) };
}

/** The `gh search repos` arguments: the words, matched against names, in each owner, leaving archived ones out. */
export function repoSearchArgs(words: readonly string[], owners: readonly string[]): string[] {
  return [
    "search",
    "repos",
    ...words,
    ...owners.map((owner) => `--owner=${owner}`),
    "--match=name",
    "--archived=false",
    `--limit=${SEARCH_LIMIT}`,
    "--json=fullName,description,hasIssues"
  ];
}

/** The repositories in `gh search repos --json`, as the hub accepts them: any with issues turned off are left out. */
export function parseRepos(stdout: string): GithubRepoFound[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const found: GithubRepoFound[] = [];
  for (const value of parsed) {
    const raw = asRecord(value);
    if (raw && typeof raw.fullName === "string" && GITHUB_REPO_RE.test(raw.fullName) && raw.hasIssues !== false) {
      found.push({ full_name: raw.fullName, description: shortText(raw.description, MAX_DESCRIPTION) });
    }
  }
  return found.slice(0, MAX_GITHUB_RESULTS);
}

/** The `gh api graphql` arguments for the Projects of `owner` whose titles match the words. */
export function projectSearchArgs(owner: string, words: readonly string[]): string[] {
  return ["api", "graphql", "-f", `query=${PROJECTS_QUERY}`, "-F", `owner=${owner}`, "-f", `q=${words.join(" ")}`];
}

/**
 * A Project named outright rather than searched for: a pasted `https://github.com/orgs/{owner}/projects/{number}` (or
 * `users/…`, with anything after the number, such as a view), or a number typed on its own, with or without `#`, which
 * is one of `owner`'s. Null for anything else, which is searched for by title.
 */
export function projectRef(query: string, owner: string): { owner: string; number: number } | null {
  const trimmed = query.trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?:orgs|users)\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/projects\/([1-9]\d{0,8})(?:[/?#].*)?$/i.exec(trimmed);
  if (link) {
    return { owner: link[1] as string, number: Number(link[2]) };
  }
  const number = /^#?([1-9]\d{0,8})$/.exec(trimmed);
  return number ? { owner, number: Number(number[1]) } : null;
}

/** The `gh api graphql` arguments for one Project by its owner and number. */
export function projectByNumberArgs(owner: string, number: number): string[] {
  return ["api", "graphql", "-f", `query=${PROJECT_QUERY}`, "-F", `owner=${owner}`, "-F", `number=${number}`];
}

/** The Project in the by-number answer, closed or not, since the person named it: none when there is no such Project. */
export function parseProject(stdout: string, owner: string): GithubProjectFound[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const data = asRecord(asRecord(parsed)?.data);
  if (data === null) {
    return null;
  }
  const raw = asRecord(asRecord(data.repositoryOwner)?.projectV2);
  const title = shortText(raw?.title, MAX_TITLE);
  return raw && Number.isInteger(raw.number) && (raw.number as number) > 0 && title !== null ? [{ owner, number: raw.number as number, title }] : [];
}

/** The open Projects in the GraphQL answer, as the hub accepts them, or null when the output is not one. */
export function parseProjects(stdout: string, owner: string): GithubProjectFound[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const data = asRecord(asRecord(parsed)?.data);
  if (data === null) {
    return null;
  }
  // An owner GitHub does not know answers a null owner, which has no Projects to offer.
  const nodes = asRecord(asRecord(data.repositoryOwner)?.projectsV2)?.nodes;
  const found: GithubProjectFound[] = [];
  for (const value of Array.isArray(nodes) ? nodes : []) {
    const raw = asRecord(value);
    const title = shortText(raw?.title, MAX_TITLE);
    if (raw && Number.isInteger(raw.number) && (raw.number as number) > 0 && title !== null && raw.closed !== true) {
      found.push({ owner, number: raw.number as number, title });
    }
  }
  return found.slice(0, MAX_GITHUB_RESULTS);
}

/** Whether GitHub refused for want of a scope the person's token was not given, which reconnecting GitHub fixes. */
export function missingScope(result: RunResult): boolean {
  try {
    const errors = asRecord(JSON.parse(result.stdout))?.errors;
    return Array.isArray(errors) && errors.some((error) => asRecord(error)?.type === "INSUFFICIENT_SCOPES");
  } catch {
    return /required scopes/i.test(result.stderr);
  }
}

const NO_PROJECT_SCOPE = "Your GitHub sign-in cannot see Projects yet: it needs the project scope. Reconnect GitHub in Connections, then search again.";

/** Why a search failed, in one line the person can read. */
export function ghLookupFailure(result: RunResult, what: "repositories" | "Projects"): string {
  if (result.code === 127) {
    return `gh is not installed in your assistant, so it cannot search GitHub ${what}.`;
  }
  if (result.code === GH_EXIT_AUTH) {
    return `Your assistant is not signed in to GitHub, so it cannot search ${what}. Reconnect GitHub in Connections.`;
  }
  if (what === "Projects" && missingScope(result)) {
    return NO_PROJECT_SCOPE;
  }
  const line =
    `${result.stderr}\n${result.stdout}`
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text !== "" && !text.startsWith("{")) ?? "";
  const why = line ? `GitHub could not search ${what}: ${line}` : `GitHub ${what} could not be searched just now.`;
  return why.length > MAX_DETAIL ? `${why.slice(0, MAX_DETAIL - 1)}…` : why;
}

/**
 * Where the owner's repositories are: their own account and every organisation they are in, as their token sees them.
 * Asked once and kept for the life of the supervisor, since nobody joins an organisation between two keystrokes; a
 * failed ask is not kept, so the next search asks again.
 */
export function githubOwners(run: Run, env: Env): () => Promise<string[] | null> {
  let known: string[] | null = null;
  return async () => {
    if (known !== null) {
      return known;
    }
    const [user, orgs] = await Promise.all([
      run("gh", ["api", "user", "--jq", ".login"], { env, timeoutMs: OWNERS_TIMEOUT_MS }),
      run("gh", ["api", "user/orgs?per_page=100", "--jq", ".[].login"], { env, timeoutMs: OWNERS_TIMEOUT_MS })
    ]);
    if (user.code !== 0) {
      return null;
    }
    const logins = [user.stdout, orgs.code === 0 ? orgs.stdout : ""]
      .join("\n")
      .split("\n")
      .map((login) => login.trim())
      .filter((login) => GITHUB_OWNER_RE.test(login));
    known = [...new Set(logins)];
    return known;
  };
}

export type GithubLookupDeps = {
  run: Run;
  env: Env;
  owners: () => Promise<string[] | null>;
};

/**
 * Runs one GitHub lookup. A repository search looks in the owner's own account and organisations, or in the one owner
 * the person typed; a Project search looks in the one owner the hub sends, the chosen repository's, since that is where
 * the boards for its issues are, unless the person pasted a Project's link or typed its number, which is looked up
 * as it stands. Never throws.
 */
export async function runGithubLookup(
  deps: GithubLookupDeps,
  frame: { kind: "github_repo" | "github_project"; query: string; owner: string | null }
): Promise<LookupAnswer> {
  if (frame.kind === "github_project") {
    if (frame.owner === null) {
      return { error: "failed", detail: "Choose the repository first: its Projects are the ones offered." };
    }
    const named = projectRef(frame.query, frame.owner);
    const args = named === null ? projectSearchArgs(frame.owner, githubWords(frame.query)) : projectByNumberArgs(named.owner, named.number);
    const result = await deps.run("gh", args, { env: deps.env, timeoutMs: SEARCH_TIMEOUT_MS });
    // A Project GitHub has no record of is a GraphQL error naming it, not an empty answer, and is simply not found.
    if (named !== null && result.code !== 0 && /Could not resolve to a ProjectV2/i.test(`${result.stdout}${result.stderr}`)) {
      return { results: [] };
    }
    let results: GithubProjectFound[] | null = null;
    if (result.code === 0) {
      results = named === null ? parseProjects(result.stdout, frame.owner) : parseProject(result.stdout, named.owner);
    }
    return results !== null ? { results } : { error: "failed", detail: ghLookupFailure(result, "Projects") };
  }
  const { owner, words } = repoQuery(frame.query);
  if (words.length === 0) {
    return { results: [] };
  }
  const owners = owner === null ? await deps.owners() : [owner];
  if (owners === null) {
    return { error: "failed", detail: "Your assistant is not signed in to GitHub, so it cannot search repositories. Reconnect GitHub in Connections." };
  }
  const result = await deps.run("gh", repoSearchArgs(words, owners), { env: deps.env, timeoutMs: SEARCH_TIMEOUT_MS });
  const results = result.code === 0 ? parseRepos(result.stdout) : null;
  return results !== null ? { results } : { error: "failed", detail: ghLookupFailure(result, "repositories") };
}
